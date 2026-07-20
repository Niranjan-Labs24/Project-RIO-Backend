import { ConflictException, NotFoundException } from '@nestjs/common';
import { orgContext } from '../../tenancy/org-context';
import { NeedsService } from './needs.service';
import type { NeedRow } from './needs.types';

function fakeTenant(opts: {
  study?: { id: string } | null;
  need?: NeedRow | null;
  onNeedCreate?: (data: Record<string, unknown>) => void;
  onNeedUpdate?: (data: Record<string, unknown>) => void;
  onStudyUpdate?: (data: Record<string, unknown>) => void;
}) {
  const tx = {
    study: {
      findUnique: async () => opts.study ?? null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        opts.onStudyUpdate?.(data);
        return {};
      },
    },
    need: {
      findUnique: async () => opts.need ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        opts.onNeedCreate?.(data);
        return { id: 'need-1', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), ...data };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        opts.onNeedUpdate?.(data);
        return { ...(opts.need as object), ...data, updatedAt: new Date('2026-01-02T00:00:00Z') };
      },
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
        orgContext.run(ctx, () => svc.create('study-1', { title: 'T', statement: 'S', village: ['V'] })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409s when the study already has a need', async () => {
      const existing: NeedRow = {
        id: 'need-0', studyId: 'study-1', orgId: 'o1', title: 'Old', statement: 'S', village: ['V'],
        source: 'manual_entry', createdBy: 'me', createdAt: new Date(), updatedAt: new Date(),
      };
      const svc = makeService(fakeTenant({ study: { id: 'study-1' }, need: existing }));
      await expect(
        orgContext.run(ctx, () => svc.create('study-1', { title: 'T', statement: 'S', village: ['V'] })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('sets source to manual_entry (never from the request), advances Study to need_captured, and records an audit event keyed off title', async () => {
      let createdData: Record<string, unknown> | undefined;
      let studyUpdateData: Record<string, unknown> | undefined;
      const recorded: unknown[] = [];
      const audit = { record: async (i: unknown) => { recorded.push(i); } };
      const svc = makeService(
        fakeTenant({
          study: { id: 'study-1' },
          need: null,
          onNeedCreate: (d) => { createdData = d; },
          onStudyUpdate: (d) => { studyUpdateData = d; },
        }),
        audit,
      );

      const need = await orgContext.run(ctx, () =>
        svc.create('study-1', { title: 'Irregular water supply', statement: 'Households...', village: ['Kadapa', 'Thimmapuram'] }),
      );

      expect(createdData?.source).toBe('manual_entry');
      expect(createdData?.title).toBe('Irregular water supply');
      expect(studyUpdateData).toEqual({ status: 'need_captured' });
      expect(need.source).toBe('manual_entry');
      expect(need.title).toBe('Irregular water supply');
      expect(recorded[0]).toMatchObject({ action: 'create', entityType: 'need', entityLabel: 'Irregular water supply' });
    });
  });

  describe('getByStudyId', () => {
    it('404s when no need exists for the study', async () => {
      const svc = makeService(fakeTenant({ need: null }));
      await expect(orgContext.run(ctx, () => svc.getByStudyId('study-1'))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the mapped Need, including title and source', async () => {
      const row: NeedRow = {
        id: 'need-1', studyId: 'study-1', orgId: 'o1', title: 'T', statement: 'S', village: ['V'],
        source: 'manual_entry', createdBy: 'me', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
      };
      const svc = makeService(fakeTenant({ need: row }));
      const need = await orgContext.run(ctx, () => svc.getByStudyId('study-1'));
      expect(need).toMatchObject({ id: 'need-1', title: 'T', source: 'manual_entry' });
    });
  });

  describe('update', () => {
    const current: NeedRow = {
      id: 'need-1', studyId: 'study-1', orgId: 'o1', title: 'Old title', statement: 'Old statement', village: ['A'],
      source: 'manual_entry', createdBy: 'me', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    };

    it('404s when no need exists for the study', async () => {
      const svc = makeService(fakeTenant({ need: null }));
      await expect(orgContext.run(ctx, () => svc.update('study-1', { title: 'New' }))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patches title/village without touching source, and records only the changed fields', async () => {
      let updateData: Record<string, unknown> | undefined;
      const recorded: { changes?: { field: string; before: unknown; after: unknown }[] }[] = [];
      const audit = { record: async (i: unknown) => { recorded.push(i as never); } };
      const svc = makeService(fakeTenant({ need: current, onNeedUpdate: (d) => { updateData = d; } }), audit);

      const updated = await orgContext.run(ctx, () =>
        svc.update('study-1', { title: 'New title', village: ['A', 'B'] }),
      );

      expect(updateData).toEqual({ title: 'New title', village: ['A', 'B'] });
      expect(updated.title).toBe('New title');
      expect(updated.source).toBe('manual_entry'); // unchanged, never accepted in the patch
      expect(recorded[0].changes).toEqual(
        expect.arrayContaining([
          { field: 'title', before: 'Old title', after: 'New title' },
          { field: 'village', before: ['A'], after: ['A', 'B'] },
        ]),
      );
      expect(recorded[0].changes).toHaveLength(2);
    });

    it('does not record an audit event when the patch changes nothing', async () => {
      const recorded: unknown[] = [];
      const audit = { record: async (i: unknown) => { recorded.push(i); } };
      const svc = makeService(fakeTenant({ need: current }), audit);
      await orgContext.run(ctx, () => svc.update('study-1', { title: current.title }));
      expect(recorded).toHaveLength(0);
    });
  });
});
