import { describe, expect, it, vi } from 'vitest';
import { orgContext, type OrgStore } from '../../tenancy/org-context';
import { NeedsService } from './needs.service';

// UAT DQ-08 — a study's merged needs stay visible (greyed, "Merged into
// NEED-xxx") without ever being counted: they come from their own read.

function setup(retired: Record<string, unknown>[]) {
  const findMany = vi.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    'studyId' in where
      ? retired
      : [{ id: 's1', internalRefSeq: 42, title: 'Clinic needed' }],
  );
  const mergeFindMany = vi.fn().mockResolvedValue([
    { retiredNeedId: 'r1', decidedAt: new Date('2026-11-10T09:00:00Z') },
    { retiredNeedId: 'r1', decidedAt: new Date('2026-11-01T09:00:00Z') },
  ]);
  const tx = { need: { findMany }, needMerge: { findMany: mergeFindMany } };
  const used: string[] = [];
  const tenant = {
    runInOrgContext: async (fn: (t: unknown) => unknown) => (used.push('org'), fn(tx)),
    runAsSupervisor: async (fn: (t: unknown) => unknown) => (used.push('supervisor'), fn(tx)),
  };
  const none = {} as never;
  const svc = new NeedsService(tenant as never, none, none, none, none, none, none, none, none);
  return { svc, findMany, mergeFindMany, used };
}

const asRole = <T>(role: string, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role } as OrgStore, fn);

describe('NeedsService.listMergedByStudyId (UAT DQ-08)', () => {
  it('lists only merged needs, each with its own reference and the need it was merged into', async () => {
    const { svc, findMany, mergeFindMany, used } = setup([
      { id: 'r1', internalRefSeq: 7, title: 'No clinic', mergedIntoNeedId: 's1' },
    ]);
    const result = await asRole('ngo_admin', () => svc.listMergedByStudyId('st1'));

    expect(used).toEqual(['org']);
    expect(findMany.mock.calls[0]![0].where).toEqual({
      studyId: 'st1',
      mergedIntoNeedId: { not: null },
    });
    // An undone merge no longer counts.
    expect(mergeFindMany.mock.calls[0]![0].where).toMatchObject({ undoneAt: null });
    expect(result).toEqual([
      {
        id: 'r1',
        internalReferenceId: 'NEED-000007',
        title: 'No clinic',
        mergedIntoNeedId: 's1',
        mergedIntoReferenceId: 'NEED-000042',
        mergedIntoTitle: 'Clinic needed',
        mergedAt: '2026-11-10T09:00:00.000Z',
      },
    ]);
  });

  it('returns nothing, without further reads, when the study has no merged needs', async () => {
    const { svc, mergeFindMany } = setup([]);
    expect(await asRole('ngo_admin', () => svc.listMergedByStudyId('st1'))).toEqual([]);
    expect(mergeFindMany).not.toHaveBeenCalled();
  });

  it('reads across organizations for a platform role', async () => {
    const { svc, used } = setup([]);
    await asRole('system_admin', () => svc.listMergedByStudyId('st1'));
    expect(used).toEqual(['supervisor']);
  });
});
