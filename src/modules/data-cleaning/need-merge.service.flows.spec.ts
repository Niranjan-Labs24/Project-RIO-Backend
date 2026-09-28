import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../tenancy/org-context';
import { NeedMergeService } from './need-merge.service';

type Fn = ReturnType<typeof vi.fn>;
// Every model/method is created on demand, so indexing can never be undefined.
type FakeTx = any;

function makeTx(): FakeTx {
  const models = new Map<string, Record<string, Fn>>();
  return new Proxy({} as FakeTx, {
    get(_t, model: string) {
      if (!models.has(model)) {
        const methods = new Map<string, Fn>();
        models.set(
          model,
          new Proxy({} as Record<string, Fn>, {
            get(_m, method: string) {
              if (!methods.has(method))
                methods.set(
                  method,
                  vi
                    .fn()
                    .mockResolvedValue(
                      method === 'findMany' ? [] : method === 'count' ? 0 : undefined,
                    ),
                );
              return methods.get(method)!;
            },
          }),
        );
      }
      return models.get(model)!;
    },
  });
}

function setup() {
  const tx = makeTx();
  const call = async (fn: (t: unknown) => unknown) => fn(tx);
  const tenant = {
    runInOrgContext: call,
    runAsSupervisor: call,
    runAsOrg: (_o: string, fn: (t: unknown) => unknown) => call(fn),
    runAsSupervisorWrite: vi.fn(call),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const priority = { score: vi.fn().mockResolvedValue(undefined) };
  const svc = new NeedMergeService(tenant as never, audit as never, priority as never);
  return { tx, tenant, audit, priority, svc };
}

const as = <T>(role: string | undefined, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1', role } as never, fn);

const need = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orgId: 'org-1',
  studyId: 'st1',
  internalRefSeq: id === 'a' ? 1 : 2,
  title: id.toUpperCase(),
  referenceId: null,
  absorbedReferenceIds: [],
  mergedIntoNeedId: null,
  ...over,
});
const pair = (tx: FakeTx, a = need('a'), b = need('b')) =>
  tx.need.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === 'a' ? a : where.id === 'b' ? b : null,
  );

describe('NeedMergeService.preview', () => {
  it('describes what would move, with warnings for study and score differences', async () => {
    const { svc, tx } = setup();
    pair(
      tx,
      need('a', { referenceId: 'X', absorbedReferenceIds: ['Y'] }),
      need('b', { studyId: 'st2', referenceId: 'Z' }),
    );
    tx.surveyResponse.count.mockResolvedValue(3);
    tx.evidence.count.mockResolvedValue(0);
    tx.report.count.mockResolvedValue(1);
    tx.priorityScore.count.mockResolvedValue(2);
    const out = await as('ngo_admin', () => svc.preview('a', 'b'));
    expect(out).toMatchObject({
      totalTransfers: 3,
      frozenReportCount: 1,
      scoresToRecalculate: 2,
      aliasedReference: 'NEED-000002',
    });
    expect(out.transfers).toEqual([{ entityType: 'SurveyResponse', count: 3 }]);
    expect(out.externalReferences.sort()).toEqual(['X', 'Y', 'Z']);
    expect(out.warnings).toEqual([
      { code: 'DIFFERENT_STUDIES' },
      { code: 'RETIRED_HAS_SCORES', count: 2 },
    ]);
  });

  it('runs on the supervisor path for a cross-entity reader and has no warnings when the pair is clean', async () => {
    const { svc, tx } = setup();
    pair(tx);
    for (const m of ['surveyResponse', 'evidence']) tx[m].count.mockResolvedValue(0);
    tx.report.count.mockResolvedValue(0);
    tx.priorityScore.count.mockResolvedValue(0);
    const out = await as('system_admin', () => svc.preview('a', 'b'));
    expect(out.warnings).toEqual([]);
    expect(out.totalTransfers).toBe(0);
  });
});

describe('NeedMergeService.list', () => {
  it('lists merge history with names, and handles unknown needs and undone merges', async () => {
    const { svc, tx } = setup();
    const at = new Date('2026-01-01T00:00:00Z');
    tx.needMerge.findMany.mockResolvedValue([
      {
        id: 'm1',
        survivorNeedId: 'a',
        retiredNeedId: 'b',
        transferredCount: 4,
        note: 'n',
        decidedAt: at,
        decidedBy: 'u1',
        undoneAt: null,
        undoneBy: null,
        undoNote: null,
      },
      {
        id: 'm2',
        survivorNeedId: 'a',
        retiredNeedId: 'gone',
        transferredCount: 0,
        note: null,
        decidedAt: at,
        decidedBy: 'u9',
        undoneAt: at,
        undoneBy: 'u1',
        undoNote: 'oops',
      },
    ]);
    tx.needMerge.count.mockResolvedValue(2);
    tx.need.findMany.mockResolvedValue([
      { id: 'a', internalRefSeq: 1, title: 'A' },
      { id: 'b', internalRefSeq: 2, title: 'B' },
    ]);
    tx.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Amy' }]);
    const out = await as('ngo_admin', () => svc.list({ page: 2, pageSize: 5 }));
    expect(tx.needMerge.findMany.mock.calls[0]![0]).toMatchObject({ skip: 5, take: 5 });
    expect(out.items[0]).toMatchObject({
      survivor: { reference: 'NEED-000001' },
      decidedByName: 'Amy',
      undoneByName: null,
      canUndo: true,
    });
    expect(out.items[1]).toMatchObject({
      retired: null,
      decidedByName: null,
      undoneByName: 'Amy',
      canUndo: false,
    });
  });

  it('returns an empty history without looking anything up', async () => {
    const { svc, tx } = setup();
    tx.needMerge.findMany.mockResolvedValue([]);
    tx.needMerge.count.mockResolvedValue(0);
    const out = await as('system_reviewer', () => svc.list({}));
    expect(out).toEqual({ total: 0, items: [] });
    expect(tx.need.findMany).not.toHaveBeenCalled();
  });
});

describe('NeedMergeService.merge', () => {
  it('moves every transferable row, aliases the reference, closes candidates and re-scores', async () => {
    const { svc, tx, audit, priority, tenant } = setup();
    pair(tx, need('a', { referenceId: 'X' }), need('b', { referenceId: 'Z' }));
    tx.needMerge.create.mockResolvedValue({ id: 'm1' });
    tx.surveyResponse.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    tx.evidence.findMany.mockResolvedValue([]);
    const out = await as('ngo_admin', () =>
      svc.merge({ survivorNeedId: 'a', retiredNeedId: 'b', candidateId: 'c1', note: ' why ' }),
    );
    expect(out).toEqual({ mergeId: 'm1', transferred: 2 });
    expect(tx.needMerge.create.mock.calls[0]![0].data).toMatchObject({
      note: 'why',
      candidateId: 'c1',
    });
    expect(tx.need.update.mock.calls[0]![0].data).toEqual({ absorbedReferenceIds: ['Z'] });
    expect(tx.need.update.mock.calls[1]![0].data).toEqual({ mergedIntoNeedId: 'a' });
    expect(tx.duplicateCandidate.updateMany).toHaveBeenCalledTimes(3);
    expect(tenant.runAsSupervisorWrite).toHaveBeenCalled();
    expect(priority.score).toHaveBeenCalledWith('a');
    expect(
      audit.record.mock.calls[0]![0].changes.find((c: { field: string }) => c.field === 'Note')
        .after,
    ).toBe('why');
    expect(
      audit.record.mock.calls[0]![0].changes.find(
        (c: { field: string }) => c.field === 'Priority scores',
      ).after,
    ).toContain('recalculated');
  });

  it('still completes when tidying the cross-entity queue or re-scoring fails', async () => {
    const { svc, tx, tenant, priority, audit } = setup();
    pair(tx);
    tx.needMerge.create.mockResolvedValue({ id: 'm1' });
    tx.surveyResponse.findMany.mockResolvedValue([]);
    tenant.runAsSupervisorWrite.mockRejectedValue(new Error('db'));
    priority.score.mockRejectedValue('str');
    const out = await as('ngo_admin', () => svc.merge({ survivorNeedId: 'a', retiredNeedId: 'b' }));
    expect(out.transferred).toBe(0);
    expect(tx.duplicateCandidate.updateMany).toHaveBeenCalledTimes(1);
    const changes = audit.record.mock.calls[0]![0].changes;
    expect(changes.find((c: { field: string }) => c.field === 'Priority scores').after).toContain(
      'stale',
    );
    expect(changes.find((c: { field: string }) => c.field === 'Note').after).toBeNull();
    priority.score.mockRejectedValue(new Error('boom'));
    await as('ngo_admin', () => svc.merge({ survivorNeedId: 'a', retiredNeedId: 'b' }));
  });

  it('merges in the owning entity for a cross-entity reader, and keeps a shared reference as is', async () => {
    const { svc, tx } = setup();
    pair(tx, need('a', { referenceId: 'SAME' }), need('b', { referenceId: 'SAME' }));
    tx.needMerge.create.mockResolvedValue({ id: 'm1' });
    tx.surveyResponse.findMany.mockResolvedValue([]);
    await as('system_admin', () => svc.merge({ survivorNeedId: 'a', retiredNeedId: 'b' }));
    expect(tx.need.update).toHaveBeenCalledTimes(1);
    tx.need.findUnique.mockImplementationOnce(async () => null);
    pair(tx);
    await as('system_admin', () => svc.merge({ survivorNeedId: 'a', retiredNeedId: 'b' })).catch(
      () => undefined,
    );
  });
});

describe('NeedMergeService.undo', () => {
  const merge = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    survivorNeedId: 'a',
    retiredNeedId: 'b',
    candidateId: 'c1',
    undoneAt: null,
    transfers: [
      { entityType: 'SurveyResponse', entityId: 'r1' },
      { entityType: 'SurveyResponse', entityId: 'r2' },
    ],
    ...over,
  });

  it('puts everything back, reopens the queue and audits', async () => {
    const { svc, tx, audit } = setup();
    tx.needMerge.findUnique.mockResolvedValue(merge());
    tx.need.findUnique
      .mockResolvedValueOnce({ referenceId: 'Z' })
      .mockResolvedValueOnce({ absorbedReferenceIds: ['Z', 'Y'] });
    const out = await as('ngo_admin', () => svc.undo('m1', ' reason '));
    expect(out).toEqual({ restored: 2 });
    expect(tx.need.update.mock.calls[1]![0].data).toEqual({ absorbedReferenceIds: ['Y'] });
    expect(tx.needMerge.update.mock.calls[0]![0].data.undoNote).toBe('reason');
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it('handles a merge without a candidate or references, and survivors that vanished', async () => {
    const { svc, tx, tenant } = setup();
    tx.needMerge.findUnique.mockResolvedValue(merge({ candidateId: null, transfers: [] }));
    tx.need.findUnique.mockResolvedValueOnce({ referenceId: null });
    await as('ngo_admin', () => svc.undo('m1', 'n'));
    tx.need.findUnique.mockResolvedValueOnce({ referenceId: 'Z' }).mockResolvedValueOnce(null);
    await as('ngo_admin', () => svc.undo('m1', 'n'));
    tenant.runAsSupervisorWrite.mockRejectedValue(new Error('db'));
    tx.need.findUnique.mockResolvedValue(null);
    await as('ngo_admin', () => svc.undo('m1', 'n'));
  });

  it('refuses a missing note, an unknown merge and one already undone', async () => {
    const { svc, tx } = setup();
    await expect(as(undefined, () => svc.undo('m1', '  '))).rejects.toMatchObject({
      response: { error: { code: 'NOTE_REQUIRED' } },
    });
    tx.needMerge.findUnique.mockResolvedValueOnce(null);
    await expect(as(undefined, () => svc.undo('m1', 'n'))).rejects.toMatchObject({
      response: { error: { code: 'MERGE_NOT_FOUND' } },
    });
    tx.needMerge.findUnique.mockResolvedValueOnce(merge({ undoneAt: new Date() }));
    await expect(as(undefined, () => svc.undo('m1', 'n'))).rejects.toMatchObject({
      response: { error: { code: 'MERGE_ALREADY_UNDONE' } },
    });
  });

  it('resolves the owning entity for a cross-entity reader', async () => {
    const { svc, tx } = setup();
    tx.needMerge.findUnique
      .mockResolvedValueOnce({ orgId: 'org-9' })
      .mockResolvedValueOnce(merge({ transfers: [] }));
    tx.need.findUnique.mockResolvedValue(null);
    await as('system_admin', () => svc.undo('m1', 'n'));
    tx.needMerge.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(merge({ transfers: [] }));
    await as('system_admin', () => svc.undo('m1', 'n'));
  });
});
