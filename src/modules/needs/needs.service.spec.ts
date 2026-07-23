import { ConflictException, NotFoundException } from '@nestjs/common';
import { orgContext } from '../../tenancy/org-context';
import { NeedsService } from './needs.service';
import type { NeedRow } from './needs.types';

function makeRow(overrides: Partial<NeedRow> = {}): NeedRow {
  return {
    id: 'need-1',
    studyId: 'study-1',
    orgId: 'o1',
    title: 'Old title',
    statement: 'Old statement',
    village: ['A'],
    source: 'manual_entry',
    referenceId: null,
    status: 'draft',
    domain: 'Water',
    subDomain: 'Access',
    aiSuggestedDomain: null,
    aiSuggestedSubDomain: null,
    createdBy: 'me',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function fakeTenant(opts: {
  study?: { id: string } | null;
  need?: NeedRow | null;
  needs?: NeedRow[];
  users?: { id: string; name: string }[];
  onNeedCreate?: (data: Record<string, unknown>) => void;
  onNeedUpdate?: (data: Record<string, unknown>) => void;
  onNeedDelete?: (where: unknown) => void;
}) {
  const tx = {
    study: {
      findUnique: async () => opts.study ?? null,
    },
    need: {
      findUnique: async () => opts.need ?? null,
      findMany: async () => opts.needs ?? [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        opts.onNeedCreate?.(data);
        return { id: 'need-new', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), ...data };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        opts.onNeedUpdate?.(data);
        return { ...(opts.need as object), ...data, updatedAt: new Date('2026-01-02T00:00:00Z') };
      },
      delete: async ({ where }: { where: unknown }) => {
        opts.onNeedDelete?.(where);
      },
    },
    user: {
      findMany: async () => opts.users ?? [],
    },
  };
  return { runInOrgContext: async (fn: (tx: unknown) => unknown) => fn(tx) };
}

function makeService(tenant: ReturnType<typeof fakeTenant>, audit: unknown = { record: async () => {} }) {
  return new NeedsService(tenant as never, audit as never);
}

const ctx = { requestId: 'r', orgId: 'o1', actorId: 'me' };

describe('NeedsService', () => {
  describe('create', () => {
    it('404s when the study does not exist', async () => {
      const svc = makeService(fakeTenant({ study: null }));
      await expect(
        orgContext.run(ctx, () =>
          svc.create('study-1', { title: 'T', statement: 'S', village: ['V'], domain: 'Water', subDomain: 'Access' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('allows a second Need under the same Study (no more one-per-study conflict)', async () => {
      const svc = makeService(fakeTenant({ study: { id: 'study-1' } }));
      const need = await orgContext.run(ctx, () =>
        svc.create('study-1', { title: 'Second need', statement: 'S', village: ['V'], domain: 'Water', subDomain: 'Access' }),
      );
      expect(need.title).toBe('Second need');
    });

    it('sets source to manual_entry (never from the request), stores domain/subDomain, defaults referenceId to null, and records an audit event keyed off title', async () => {
      let createdData: Record<string, unknown> | undefined;
      const recorded: unknown[] = [];
      const audit = { record: async (i: unknown) => { recorded.push(i); } };
      const svc = makeService(
        fakeTenant({ study: { id: 'study-1' }, onNeedCreate: (d) => { createdData = d; }, users: [{ id: 'me', name: 'Me' }] }),
        audit,
      );

      const need = await orgContext.run(ctx, () =>
        svc.create('study-1', {
          title: 'Irregular water supply',
          statement: 'Households...',
          village: ['Kadapa', 'Thimmapuram'],
          domain: 'Water & Sanitation',
          subDomain: 'Access',
        }),
      );

      expect(createdData?.source).toBe('manual_entry');
      expect(createdData?.domain).toBe('Water & Sanitation');
      expect(createdData?.subDomain).toBe('Access');
      expect(createdData?.referenceId).toBeNull();
      expect(need.source).toBe('manual_entry');
      expect(need.createdByName).toBe('Me');
      expect(recorded[0]).toMatchObject({ action: 'create', entityType: 'need', entityLabel: 'Irregular water supply' });
    });

    it('stores referenceId when provided', async () => {
      let createdData: Record<string, unknown> | undefined;
      const svc = makeService(fakeTenant({ study: { id: 'study-1' }, onNeedCreate: (d) => { createdData = d; } }));
      await orgContext.run(ctx, () =>
        svc.create('study-1', { title: 'T', statement: 'S', village: ['V'], domain: 'Water', subDomain: 'Access', referenceId: 'FIELD-42' }),
      );
      expect(createdData?.referenceId).toBe('FIELD-42');
    });
  });

  describe('listByStudyId', () => {
    it('maps every Need under the Study, resolving each creator name', async () => {
      const rows = [makeRow({ id: 'n1', createdBy: 'u1' }), makeRow({ id: 'n2', createdBy: 'u2' })];
      const svc = makeService(fakeTenant({ needs: rows, users: [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }] }));
      const needs = await orgContext.run(ctx, () => svc.listByStudyId('study-1'));
      expect(needs.map((n) => n.createdByName)).toEqual(['Alice', 'Bob']);
    });
  });

  describe('getById', () => {
    it('404s when the need does not exist', async () => {
      const svc = makeService(fakeTenant({ need: null }));
      await expect(orgContext.run(ctx, () => svc.getById('need-1'))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the mapped Need, including domain/subDomain and AI-suggested fields', async () => {
      const row = makeRow({ aiSuggestedDomain: 'Health', aiSuggestedSubDomain: 'Nutrition' });
      const svc = makeService(fakeTenant({ need: row, users: [{ id: 'me', name: 'Me' }] }));
      const need = await orgContext.run(ctx, () => svc.getById('need-1'));
      expect(need).toMatchObject({ domain: 'Water', subDomain: 'Access', aiSuggestedDomain: 'Health', aiSuggestedSubDomain: 'Nutrition' });
    });
  });

  describe('update', () => {
    it('404s when the need does not exist', async () => {
      const svc = makeService(fakeTenant({ need: null }));
      await expect(orgContext.run(ctx, () => svc.update('need-1', { title: 'New' }))).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each(['evidence_submitted', 'ai_classified', 'reviewer_approved', 'survey_created', 'survey_published'])(
      '409s once the need is past draft (%s) and never updates',
      async (status) => {
        let updated = false;
        const svc = makeService(fakeTenant({ need: makeRow({ status: status as NeedRow['status'] }), onNeedUpdate: () => { updated = true; } }));
        await expect(orgContext.run(ctx, () => svc.update('need-1', { title: 'New' }))).rejects.toBeInstanceOf(ConflictException);
        expect(updated).toBe(false);
      },
    );

    it('patches title/village/domain/subDomain while still draft, and records only the changed fields under their display labels', async () => {
      let updateData: Record<string, unknown> | undefined;
      const recorded: { changes?: { field: string; before: unknown; after: unknown }[] }[] = [];
      const audit = { record: async (i: unknown) => { recorded.push(i as never); } };
      const current = makeRow();
      const svc = makeService(fakeTenant({ need: current, onNeedUpdate: (d) => { updateData = d; }, users: [{ id: 'me', name: 'Me' }] }), audit);

      const updated = await orgContext.run(ctx, () =>
        svc.update('need-1', { title: 'New title', village: ['A', 'B'], domain: 'Health' }),
      );

      expect(updateData).toEqual({ title: 'New title', village: ['A', 'B'], domain: 'Health' });
      expect(updated.title).toBe('New title');
      expect(recorded[0].changes).toEqual(
        expect.arrayContaining([
          { field: 'Title', before: 'Old title', after: 'New title' },
          { field: 'Governorate', before: ['A'], after: ['A', 'B'] },
          { field: 'Domain', before: 'Water', after: 'Health' },
        ]),
      );
      expect(recorded[0].changes).toHaveLength(3);
    });

    it('allows clearing referenceId to null explicitly', async () => {
      let updateData: Record<string, unknown> | undefined;
      const current = makeRow({ referenceId: 'FIELD-1' });
      const svc = makeService(fakeTenant({ need: current, onNeedUpdate: (d) => { updateData = d; } }));
      await orgContext.run(ctx, () => svc.update('need-1', { referenceId: null }));
      expect(updateData).toEqual({ referenceId: null });
    });

    it('does not record an audit event when the patch changes nothing', async () => {
      const recorded: unknown[] = [];
      const audit = { record: async (i: unknown) => { recorded.push(i); } };
      const current = makeRow();
      const svc = makeService(fakeTenant({ need: current }), audit);
      await orgContext.run(ctx, () => svc.update('need-1', { title: current.title }));
      expect(recorded).toHaveLength(0);
    });
  });

  describe('remove', () => {
    it('404s when the need does not exist', async () => {
      const svc = makeService(fakeTenant({ need: null }));
      await expect(orgContext.run(ctx, () => svc.remove('need-1'))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deletes and records an audit event while still draft', async () => {
      let deletedWhere: unknown;
      const recorded: unknown[] = [];
      const audit = { record: async (i: unknown) => { recorded.push(i); } };
      const svc = makeService(fakeTenant({ need: makeRow(), onNeedDelete: (w) => { deletedWhere = w; } }), audit);
      await orgContext.run(ctx, () => svc.remove('need-1'));
      expect(deletedWhere).toEqual({ id: 'need-1' });
      expect(recorded[0]).toMatchObject({ action: 'delete', entityType: 'need', entityId: 'need-1' });
    });

    it.each(['evidence_submitted', 'ai_classified', 'reviewer_approved', 'survey_created', 'survey_published'])(
      '409s once the need is past draft (%s) and never deletes',
      async (status) => {
        let deleted = false;
        const svc = makeService(fakeTenant({ need: makeRow({ status: status as NeedRow['status'] }), onNeedDelete: () => { deleted = true; } }));
        await expect(orgContext.run(ctx, () => svc.remove('need-1'))).rejects.toBeInstanceOf(ConflictException);
        expect(deleted).toBe(false);
      },
    );
  });
});
