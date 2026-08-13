import { describe, expect, it } from 'vitest';
import { ReviewerSlaService } from './reviewer-sla.service';
import { orgContext } from '../../tenancy/org-context';

// Minimal local shapes for this file's own mock fixtures — only the fields
// ReviewerSlaService actually reads.
interface FakeSurvey {
  id: string;
  needId: string;
  studyId: string;
  status: string;
  createdBy?: string;
  submittedAt?: Date | null;
  publishedAt?: Date | null;
  rejectedAt?: Date | null;
  updatedAt: Date;
  approverComments?: string | null;
}
interface FakeReport {
  id: string;
  studyId: string | null;
  status: string;
  title: string;
  generatedBy?: string;
  generatedAt: Date;
  officerConfirmedAt?: Date | null;
  reviewedAt?: Date | null;
}
interface FakeStudy { id: string; title: string }
interface FakeNeed { id: string; statement: string | null }
interface FakeEvidenceDocument {
  id: string;
  studyId: string;
  linkedNeedId: string | null;
  createdAt: Date;
}

function fakeTenant(opts: {
  surveys?: FakeSurvey[];
  reports?: FakeReport[];
  studies?: FakeStudy[];
  needs?: FakeNeed[];
  evidenceDocuments?: FakeEvidenceDocument[];
}) {
  const tx = {
    survey: { findMany: async () => opts.surveys ?? [] },
    report: { findMany: async () => opts.reports ?? [] },
    study: { findMany: async () => opts.studies ?? [] },
    need: { findMany: async () => opts.needs ?? [] },
    evidenceDocument: { findMany: async () => opts.evidenceDocuments ?? [] },
  };
  return {
    runInOrgContext: async (fn: (tx: unknown) => unknown) => fn(tx),
  };
}

const configStub = { reviewerSlaHours: 48, reviewerSlaPollIntervalMs: 30_000 };

function makeService(tenant: ReturnType<typeof fakeTenant>) {
  return new ReviewerSlaService(tenant as never, configStub as never);
}

describe('ReviewerSlaService', () => {
  it('Approver (human_reviewer) sees both pending survey_approval and report_approval alerts, oldest first', async () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-01-02T00:00:00Z');
    const svc = makeService(
      fakeTenant({
        surveys: [
          { id: 's1', needId: 'n1', studyId: 'st1', status: 'SUBMITTED', submittedAt: newer, updatedAt: newer },
        ],
        reports: [
          { id: 'r1', studyId: 'st2', status: 'submitted', title: 'Village Report', officerConfirmedAt: older, generatedAt: older },
        ],
        studies: [{ id: 'st1', title: 'Study One' }, { id: 'st2', title: 'Study Two' }],
        needs: [{ id: 'n1', statement: 'Need statement' }],
      }),
    );

    const alerts = await orgContext.run({ requestId: 'r', role: 'human_reviewer' }, () => svc.listAlerts());

    expect(alerts).toHaveLength(2);
    // Oldest-first for the still-open queue — the report (confirmed 2026-01-01) precedes the survey (submitted 2026-01-02).
    expect(alerts[0]?.type).toBe('report_approval');
    expect(alerts[0]?.reportId).toBe('r1');
    expect(alerts[0]?.studyTitle).toBe('Village Report');
    expect(alerts[0]?.status).toBe('pending');
    expect(alerts[1]?.type).toBe('survey_approval');
    expect(alerts[1]?.surveyId).toBe('s1');
  });

  // RIO-RBAC-001 matrix (Aug 11, client-confirmed): ngo_admin no longer
  // holds reportsDashboards:approve (view/export/share only now), so it's
  // no longer this test's "sees approval alerts" reference role —
  // human_reviewer is the role the confirmed matrix actually grants
  // Reports:Approve to.
  it('Human Reviewer (holds reportsDashboards:approve) sees report_approval alerts', async () => {
    const svc = makeService(
      fakeTenant({
        reports: [
          { id: 'r1', studyId: null, status: 'submitted', title: 'Org-wide Report', officerConfirmedAt: new Date(), generatedAt: new Date() },
        ],
      }),
    );
    const alerts = await orgContext.run({ requestId: 'r', role: 'human_reviewer' }, () => svc.listAlerts());
    const reportAlert = alerts.find((a) => a.type === 'report_approval');
    expect(reportAlert).toBeDefined();
    expect(reportAlert?.studyId).toBeNull(); // org-wide report, no Study
  });

  // RIO-RBAC-001 matrix, refined (Aug 12, client-confirmed): Research
  // Officer regained reportsDashboards:write (the officer-confirm step) —
  // restores this role as the natural reference for "own report" alerts.
  it('Research Officer sees their own resolved report alerts (released/rejected), newest first', async () => {
    const svc = makeService(
      fakeTenant({
        reports: [
          { id: 'r1', studyId: 'st1', status: 'released', title: 'Released Report', generatedBy: 'me', reviewedAt: new Date('2026-01-01T00:00:00Z'), generatedAt: new Date('2025-12-01T00:00:00Z') },
          { id: 'r2', studyId: 'st1', status: 'rejected', title: 'Rejected Report', generatedBy: 'me', reviewedAt: new Date('2026-01-05T00:00:00Z'), generatedAt: new Date('2025-12-01T00:00:00Z') },
        ],
      }),
    );

    const alerts = await orgContext.run(
      { requestId: 'r', actorId: 'me', role: 'ngo_research_officer' },
      () => svc.listAlerts(),
    );

    const reportAlerts = alerts.filter((a) => a.type === 'report_released' || a.type === 'report_rejected');
    expect(reportAlerts).toHaveLength(2);
    // Newest resolution first.
    expect(reportAlerts[0]?.id).toBe('r2');
    expect(reportAlerts[0]?.type).toBe('report_rejected');
    expect(reportAlerts[1]?.id).toBe('r1');
    expect(reportAlerts[1]?.type).toBe('report_released');
  });

  it('a role with neither reportsDashboards:approve nor :write gets no report alerts', async () => {
    const svc = makeService(fakeTenant({ reports: [{ id: 'r1', studyId: null, status: 'submitted', title: 'X', officerConfirmedAt: new Date(), generatedAt: new Date() }] }));
    // read_only_viewer holds neither approve nor write on reportsDashboards.
    const alerts = await orgContext.run(
      { requestId: 'r', actorId: 'me', role: 'read_only_viewer' },
      () => svc.listAlerts(),
    );
    expect(alerts.some((a) => a.type.startsWith('report_'))).toBe(false);
  });

  it('Data Analyst sees evidence_document_uploaded alerts for Needs-linked documents', async () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-01-02T00:00:00Z');
    const svc = makeService(
      fakeTenant({
        evidenceDocuments: [
          { id: 'd2', studyId: 'st1', linkedNeedId: 'n1', createdAt: newer },
          { id: 'd1', studyId: 'st1', linkedNeedId: 'n1', createdAt: older },
        ],
        studies: [{ id: 'st1', title: 'Study One' }],
        needs: [{ id: 'n1', statement: 'Need statement' }],
      }),
    );

    const alerts = await orgContext.run(
      { requestId: 'r', actorId: 'me', role: 'data_analyst' },
      () => svc.listAlerts(),
    );

    const evidenceAlerts = alerts.filter((a) => a.type === 'evidence_document_uploaded');
    expect(evidenceAlerts).toHaveLength(2);
    // data_analyst holds neither surveyBuilder:approve nor
    // reportsDashboards:approve (only priorityScoring:create, which the
    // final merge-sort deliberately doesn't key on — see listAlerts' own
    // comment), so the global sort here is newest-first, even though
    // listPendingEvidenceSummaryAlerts' own internal order is oldest-first.
    expect(evidenceAlerts[0]?.id).toBe('d2');
    expect(evidenceAlerts[1]?.id).toBe('d1');
    const d1 = evidenceAlerts.find((a) => a.id === 'd1');
    expect(d1?.needId).toBe('n1');
    expect(d1?.studyTitle).toBe('Study One');
    expect(d1?.needStatement).toBe('Need statement');
    expect(d1?.status).toBe('pending');
    expect(evidenceAlerts.find((a) => a.id === 'd2')?.needId).toBe('n1');
  });

  it('a role without priorityScoring:create (e.g. the Research Officer who uploaded it) gets no evidence_document_uploaded alerts', async () => {
    const svc = makeService(
      fakeTenant({
        evidenceDocuments: [{ id: 'd1', studyId: 'st1', linkedNeedId: 'n1', createdAt: new Date() }],
      }),
    );
    const alerts = await orgContext.run(
      { requestId: 'r', actorId: 'me', role: 'ngo_research_officer' },
      () => svc.listAlerts(),
    );
    expect(alerts.some((a) => a.type === 'evidence_document_uploaded')).toBe(false);
  });

  it('getConfig returns the configured SLA hours and poll interval', () => {
    const svc = makeService(fakeTenant({}));
    expect(svc.getConfig()).toEqual({ slaHours: 48, pollIntervalMs: 30_000 });
  });
});
