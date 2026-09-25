import { describe, expect, it } from 'vitest';
import { makeFakeTx } from '../../../test/support/fake-tx';
import { orgContext } from '../../tenancy/org-context';
import { SupervisorOverviewService } from './supervisor-overview.service';

function setup() {
  const tx = makeFakeTx();
  const tenant = { runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx) };
  return { tx, svc: new SupervisorOverviewService(tenant as never) };
}
const as = <T>(role: string | undefined, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'o', actorId: 'u', role } as never, fn);
const at = (d: string) => new Date(`${d}T00:00:00Z`);

describe('SupervisorOverviewService', () => {
  it('refuses roles that cannot read across entities', async () => {
    const { svc } = setup();
    await expect(as('ngo_admin', () => svc.getOverview())).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
    await expect(as(undefined, () => svc.getOverview())).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
    await expect(as('unknown_role', () => svc.getOverview())).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
  });

  it('summarises every organisation with its active study, latest report and sharing state', async () => {
    const { svc, tx } = setup();
    tx.organisation.findMany.mockResolvedValue([
      { id: 'o1', name: 'One', updatedAt: at('2026-01-01') },
      { id: 'o2', name: 'Two', updatedAt: at('2026-01-05') },
    ]);
    tx.study.findMany.mockResolvedValue([
      { id: 's1', orgId: 'o1', title: 'Newest', updatedAt: at('2026-02-01') },
      { id: 's2', orgId: 'o1', title: 'Open', updatedAt: at('2026-01-20') },
    ]);
    tx.need.findMany.mockResolvedValue([
      { studyId: 's1', status: 'survey_published' },
      { studyId: 's2', status: 'draft' },
    ]);
    tx.report.findMany.mockResolvedValue([
      { orgId: 'o1', title: 'R2' },
      { orgId: 'o1', title: 'R1' },
    ]);
    tx.sharingRequest.findMany.mockResolvedValue([
      { ownerOrgId: 'o1', requestingOrgId: 'o2', status: 'approved' },
      { ownerOrgId: 'o2', requestingOrgId: 'o1', status: 'pending' },
    ]);
    const out = await as('center_supervisor', () => svc.getOverview());
    expect(out).toMatchObject({
      totalOrganizations: 2,
      studiesInProgress: 1,
      reportsShared: 1,
      pendingSharingRequests: 1,
    });
    expect(out.rows[0]).toMatchObject({
      activeStudyTitle: 'Open',
      latestReportTitle: 'R2',
      sharingStatus: 'approved',
      lastActivity: at('2026-02-01').toISOString(),
    });
    expect(out.rows[1]).toMatchObject({
      activeStudyTitle: null,
      latestReportTitle: null,
      sharingStatus: 'approved',
      lastActivity: at('2026-01-05').toISOString(),
    });
  });

  it('reports a quiet organisation with nothing attached', async () => {
    const { svc, tx } = setup();
    tx.organisation.findMany.mockResolvedValue([
      { id: 'o1', name: 'One', updatedAt: at('2026-01-01') },
    ]);
    const out = await as('system_admin', () => svc.getOverview());
    expect(out.rows[0]).toMatchObject({ activeStudyTitle: null, sharingStatus: null });
  });
});
