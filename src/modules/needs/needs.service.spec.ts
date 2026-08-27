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
    governorateIds: [],
    centerIds: [],
    source: 'manual_entry',
    referenceId: null,
    internalRefSeq: 1,
    status: 'draft',
    domain: 'Water',
    subDomain: 'Access',
    allDomainsSelected: false,
    needDomains: [{ domain: 'Water', subDomain: 'Access' }],
    aiSuggestedDomain: null,
    aiSuggestedSubDomain: null,
    classifiedAt: null,
    classificationError: null,
    proposedDomains: null,
    proposedReason: null,
    gapType: null,
    urgency: null,
    themes: [],
    affectedPeople: null,
    affectedHouseholds: null,
    createdBy: 'me',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// Prisma returns needGovernorates/needCenters as join-row arrays once
// GEO_INCLUDE is applied — NeedsService.toNeedRow() flattens that back down
// to governorateIds/centerIds. Mirrors that raw shape here so the service's
// own flattening logic is exercised the same way it is in production.
function withGeo(row: NeedRow) {
  const { governorateIds, centerIds, ...rest } = row;
  return {
    ...rest,
    needGovernorates: governorateIds.map((governorateId) => ({ governorateId })),
    needCenters: centerIds.map((centerId) => ({ centerId })),
    needDomains: row.needDomains,
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
  // RIO-AI-001: the latest need_classification AiDecision per Need, backing
  // resolveAiConfidence. Defaults to none, i.e. "no classification has run",
  // which is what most of these fixtures represent.
  aiDecisions?: { needId: string; confidence: number | null }[];
}) {
  const tx = {
    study: {
      findUnique: async () => opts.study ?? null,
    },
    need: {
      // Reads opts.need fresh each call (rather than a snapshot) so that
      // update()'s own tx.need.update -> re-findUnique sequence sees
      // whatever onNeedUpdate mutated it to, same as a real transaction.
      findUnique: async () => (opts.need ? withGeo(opts.need) : null),
      findMany: async () => (opts.needs ?? []).map(withGeo),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        opts.onNeedCreate?.(data);
        return { id: 'need-new', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), ...data };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        opts.onNeedUpdate?.(data);
        if (opts.need) Object.assign(opts.need, data);
      },
      delete: async ({ where }: { where: unknown }) => {
        opts.onNeedDelete?.(where);
      },
    },
    needGovernorate: {
      deleteMany: async () => {},
      createMany: async () => {},
    },
    needCenter: {
      deleteMany: async () => {},
      createMany: async () => {},
    },
    user: {
      findMany: async () => opts.users ?? [],
    },
    aiDecision: {
      findMany: async () => opts.aiDecisions ?? [],
    },
  };
  return { runInOrgContext: async (fn: (tx: unknown) => unknown) => fn(tx) };
}

function fakeAiDecisions(onClassify?: (needId: string) => void) {
  return {
    classifyAutomatically: async (needId: string) => {
      onClassify?.(needId);
    },
  };
}

function makeService(
  tenant: ReturnType<typeof fakeTenant>,
  audit: unknown = { record: async () => {} },
  aiDecisions: unknown = fakeAiDecisions(),
) {
  // geography is only consulted when a payload carries governorateIds/
  // centerIds (see assertGeographyInStudyScope's early return) — none of
  // these tests do, so an empty stub is enough.
  //
  // methodologyConfig backs resolveAiConfidence's banding. The defaults are
  // named explicitly rather than imported so a future change to the shipped
  // defaults can't silently move what these tests assert against.
  const methodologyConfig = {
    getRaw: async () => ({
      aiClassificationSettings: { lowConfidenceThreshold: 0.7, veryLowConfidenceThreshold: 0.4 },
    }),
  };
  // RIO-AI-003's auto-suggest is fire-and-forget on create/update. These tests
  // assert on the Need write itself, so the stub only has to not reject —
  // NeedSummaryService's own behaviour is covered in need-summary.service.spec.
  const needSummaries = {
    maybeGenerateForNeed: async () => null,
    markStaleForNeed: async () => undefined,
  };
  // RIO-FR-003's theme extraction is fire-and-forget on the same paths, and
  // has its own spec — the stub only has to resolve.
  const needThemes = { maybeExtractForNeed: async () => null };
  return new NeedsService(
    tenant as never,
    audit as never,
    {} as never,
    aiDecisions as never,
    methodologyConfig as never,
    needThemes as never,
    needSummaries as never,
  );
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

    it('allows a second Need under the same Study (no more one-per-study conflict)', async () => {
      const svc = makeService(fakeTenant({ study: { id: 'study-1' } }));
      const need = await orgContext.run(ctx, () =>
        svc.create('study-1', { title: 'Second need', statement: 'S', village: ['V'] }),
      );
      expect(need.title).toBe('Second need');
    });

    it('sets source to manual_entry (never from the request), starts pending_ai_classification, defaults referenceId to null, and records an audit event keyed off title', async () => {
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
        }),
      );

      expect(createdData?.source).toBe('manual_entry');
      expect(createdData?.status).toBe('pending_ai_classification');
      expect(createdData?.referenceId).toBeNull();
      expect(need.source).toBe('manual_entry');
      expect(need.status).toBe('pending_ai_classification');
      expect(need.createdByName).toBe('Me');
      expect(recorded[0]).toMatchObject({ action: 'create', entityType: 'need', entityLabel: 'Irregular water supply' });
    });

    it('kicks off automatic AI classification for the new Need (fire-and-forget)', async () => {
      const classified: string[] = [];
      const svc = makeService(
        fakeTenant({ study: { id: 'study-1' } }),
        { record: async () => {} },
        fakeAiDecisions((id) => classified.push(id)),
      );
      const need = await orgContext.run(ctx, () =>
        svc.create('study-1', { title: 'T', statement: 'S', village: ['V'] }),
      );
      expect(classified).toEqual([need.id]);
    });

    it('stores referenceId when provided', async () => {
      let createdData: Record<string, unknown> | undefined;
      const svc = makeService(fakeTenant({ study: { id: 'study-1' }, onNeedCreate: (d) => { createdData = d; } }));
      await orgContext.run(ctx, () =>
        svc.create('study-1', { title: 'T', statement: 'S', village: ['V'], referenceId: 'FIELD-42' }),
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

  // RIO-AI-001 — the Needs list is where a reviewer decides which Need to
  // open, so the confidence has to be visible (and filterable) there rather
  // than only inside each Need.
  describe('AI confidence banding', () => {
    it('reports no band at all when no classification has run', async () => {
      // Distinct from 'not_reported': nothing has been suggested yet, so
      // there is nothing to flag.
      const svc = makeService(fakeTenant({ need: makeRow(), users: [{ id: 'me', name: 'Me' }] }));
      const need = await orgContext.run(ctx, () => svc.getById('need-1'));
      expect(need.aiConfidence).toBeNull();
      expect(need.aiConfidenceBand).toBeNull();
    });

    it('bands a confident classification as standard', async () => {
      const svc = makeService(
        fakeTenant({ need: makeRow(), users: [{ id: 'me', name: 'Me' }], aiDecisions: [{ needId: 'need-1', confidence: 0.91 }] }),
      );
      const need = await orgContext.run(ctx, () => svc.getById('need-1'));
      expect(need).toMatchObject({ aiConfidence: 0.91, aiConfidenceBand: 'standard' });
    });

    it('bands a below-threshold classification as low', async () => {
      const svc = makeService(
        fakeTenant({ need: makeRow(), users: [{ id: 'me', name: 'Me' }], aiDecisions: [{ needId: 'need-1', confidence: 0.55 }] }),
      );
      const need = await orgContext.run(ctx, () => svc.getById('need-1'));
      expect(need).toMatchObject({ aiConfidence: 0.55, aiConfidenceBand: 'low' });
    });

    it('bands an unreported confidence as not_reported rather than 0', async () => {
      const svc = makeService(
        fakeTenant({ need: makeRow(), users: [{ id: 'me', name: 'Me' }], aiDecisions: [{ needId: 'need-1', confidence: null }] }),
      );
      const need = await orgContext.run(ctx, () => svc.getById('need-1'));
      expect(need).toMatchObject({ aiConfidence: null, aiConfidenceBand: 'not_reported' });
    });

    it('uses the newest decision when a Need has been re-classified', async () => {
      // Rows arrive oldest-first; the last write per Need must win, otherwise
      // a Retry would keep showing the confidence of the attempt it replaced.
      const svc = makeService(
        fakeTenant({
          need: makeRow(),
          users: [{ id: 'me', name: 'Me' }],
          aiDecisions: [
            { needId: 'need-1', confidence: 0.2 },
            { needId: 'need-1', confidence: 0.88 },
          ],
        }),
      );
      const need = await orgContext.run(ctx, () => svc.getById('need-1'));
      expect(need).toMatchObject({ aiConfidence: 0.88, aiConfidenceBand: 'standard' });
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

    it('patches title/statement/village while still draft, and records only the changed fields under their display labels', async () => {
      let updateData: Record<string, unknown> | undefined;
      const recorded: { changes?: { field: string; before: unknown; after: unknown }[] }[] = [];
      const audit = { record: async (i: unknown) => { recorded.push(i as never); } };
      const current = makeRow();
      const svc = makeService(fakeTenant({ need: current, onNeedUpdate: (d) => { updateData = d; }, users: [{ id: 'me', name: 'Me' }] }), audit);

      const updated = await orgContext.run(ctx, () =>
        svc.update('need-1', { title: 'New title', village: ['A', 'B'] }),
      );

      expect(updateData).toEqual({ title: 'New title', village: ['A', 'B'] });
      expect(updated.title).toBe('New title');
      const changes = recorded[0]?.changes ?? [];
      expect(changes).toEqual(
        expect.arrayContaining([
          { field: 'Title', before: 'Old title', after: 'New title' },
          { field: 'Village', before: ['A'], after: ['A', 'B'] },
        ]),
      );
      expect(changes).toHaveLength(2);
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

    it.each(['pending_ai_classification', 'ai_classification_failed'])(
      're-triggers automatic AI classification when a change is made while status is %s',
      async (status) => {
        const classified: string[] = [];
        const current = makeRow({ status: status as NeedRow['status'] });
        const svc = makeService(
          fakeTenant({ need: current, users: [{ id: 'me', name: 'Me' }] }),
          { record: async () => {} },
          fakeAiDecisions((id) => classified.push(id)),
        );
        await orgContext.run(ctx, () => svc.update('need-1', { title: 'New title' }));
        expect(classified).toEqual(['need-1']);
      },
    );
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
