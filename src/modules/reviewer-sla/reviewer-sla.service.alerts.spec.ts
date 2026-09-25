import { describe, expect, it } from 'vitest';
import { makeFakeTx } from '../../../test/support/fake-tx';
import { orgContext } from '../../tenancy/org-context';
import { ReviewerSlaService } from './reviewer-sla.service';

function setup() {
  const tx = makeFakeTx();
  const tenant = { runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx) };
  const config = { reviewerSlaHours: 10, reviewerSlaPollIntervalMs: 5000 };
  return { tx, svc: new ReviewerSlaService(tenant as never, config as never) };
}
const as = <T>(role: string | undefined, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'o', actorId: 'u1', role } as never, fn);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const study = { id: 's1', title: 'Study' };
const need = { id: 'n1', statement: 'Stmt' };

describe('ReviewerSlaService', () => {
  it('reports its configuration', () => {
    expect(setup().svc.getConfig()).toEqual({ slaHours: 10, pollIntervalMs: 5000 });
  });

  it('gives an approver the open queues, oldest first, with SLA status for surveys', async () => {
    const { svc, tx } = setup();
    tx.survey.findMany.mockResolvedValue([
      { id: 'sv1', studyId: 's1', needId: 'n1', submittedAt: hoursAgo(20), updatedAt: new Date() },
      {
        id: 'sv2',
        studyId: 'gone',
        needId: 'gone',
        submittedAt: hoursAgo(8),
        updatedAt: new Date(),
      },
      { id: 'sv3', studyId: 's1', needId: 'n1', submittedAt: null, updatedAt: hoursAgo(1) },
    ]);
    tx.study.findMany.mockResolvedValue([study]);
    tx.need.findMany.mockResolvedValue([
      need,
      { id: 'n2', statement: 'S2', studyId: 's1', classifiedAt: hoursAgo(5) },
      { id: 'n3', statement: 'S3', studyId: 's1', classifiedAt: null },
    ]);
    tx.report.findMany.mockResolvedValue([
      { id: 'r1', studyId: 's1', title: 'Rep', officerConfirmedAt: hoursAgo(3) },
      { id: 'r2', studyId: null, title: 'Org report', officerConfirmedAt: hoursAgo(2) },
    ]);
    tx.needStatementSummary.findMany.mockResolvedValue([
      {
        id: 'ns1',
        needId: 'n1',
        studyId: 's1',
        generatedAt: hoursAgo(4),
        need: { statement: 'Stmt' },
      },
      { id: 'ns2', needId: 'n9', studyId: 'gone', generatedAt: hoursAgo(1), need: null },
    ]);
    const out = await as('human_reviewer', () => svc.listAlerts());
    const survey = out.filter((a) => a.type === 'survey_approval');
    expect(survey.map((a) => a.status)).toEqual(['breached', 'at_risk', 'pending']);
    expect(survey[1]).toMatchObject({ studyTitle: 'gone', needStatement: null });
    expect(out.filter((a) => a.type === 'report_approval').map((a) => a.needStatement)).toEqual([
      'Study',
      null,
    ]);
    expect(out.filter((a) => a.type === 'need_summary_approval')).toHaveLength(2);
    expect(out.filter((a) => a.type === 'ai_classification')).toHaveLength(3);
    const times = out.map((a) => new Date(a.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('gives a research officer their own resolved surveys, reports and classification decisions, newest first', async () => {
    const { svc, tx } = setup();
    tx.survey.findMany.mockResolvedValue([
      {
        id: 'a',
        status: 'APPROVED',
        studyId: 's1',
        needId: 'n1',
        approvedAt: hoursAgo(1),
        rejectedAt: null,
        updatedAt: new Date(),
        approverComments: 'ok',
      },
      {
        id: 'b',
        status: 'REJECTED',
        studyId: 'x',
        needId: 'x',
        approvedAt: null,
        rejectedAt: null,
        updatedAt: hoursAgo(3),
        approverComments: 'no',
      },
      {
        id: 'c',
        status: 'REJECTED',
        studyId: 's1',
        needId: 'n1',
        approvedAt: null,
        rejectedAt: hoursAgo(2),
        updatedAt: new Date(),
        approverComments: null,
      },
    ]);
    tx.study.findMany.mockResolvedValue([study]);
    tx.need.findMany.mockResolvedValue([need]);
    tx.report.findMany.mockResolvedValue([
      {
        id: 'r1',
        status: 'released',
        studyId: 's1',
        title: 'T',
        reviewedAt: hoursAgo(1),
        generatedAt: hoursAgo(9),
      },
      {
        id: 'r2',
        status: 'rejected',
        studyId: null,
        title: 'T2',
        reviewedAt: null,
        generatedAt: hoursAgo(5),
      },
    ]);
    tx.aiDecision.findMany.mockResolvedValue([
      {
        id: 'd1',
        studyId: 's1',
        needId: 'n1',
        decidedAt: hoursAgo(1),
        humanDecision: { decision: 'rejected', notes: 'bad' },
      },
      {
        id: 'd2',
        studyId: 's1',
        needId: 'n1',
        decidedAt: hoursAgo(2),
        humanDecision: { decision: 'rejected' },
      },
      {
        id: 'd3',
        studyId: 'x',
        needId: 'x',
        decidedAt: hoursAgo(3),
        humanDecision: { decision: 'approved' },
      },
      { id: 'd4', studyId: 's1', needId: 'n1', decidedAt: hoursAgo(4), humanDecision: null },
    ]);
    const out = await as('ngo_research_officer', () => svc.listAlerts());
    expect(
      out
        .filter((a) => a.type.startsWith('survey_'))
        .map((a) => a.type)
        .sort(),
    ).toEqual(['survey_ready_to_publish', 'survey_rejected', 'survey_rejected']);
    expect(
      out
        .filter((a) => a.type.startsWith('report_'))
        .map((a) => a.type)
        .sort(),
    ).toEqual(['report_rejected', 'report_released']);
    const classification = out.filter((a) => a.type.startsWith('ai_classification_'));
    expect(classification.map((a) => a.comments)).toEqual(['bad', null, null, null]);
    const times = out.map((a) => new Date(a.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('gives a data analyst the evidence documents that still need a summary', async () => {
    const { svc, tx } = setup();
    tx.evidenceDocument.findMany.mockResolvedValue([
      { id: 'e1', studyId: 's1', linkedNeedId: 'n1', createdAt: hoursAgo(2) },
      { id: 'e2', studyId: 'gone', linkedNeedId: null, createdAt: hoursAgo(1) },
    ]);
    tx.study.findMany.mockResolvedValue([study]);
    tx.need.findMany.mockResolvedValue([need]);
    const out = await as('data_analyst', () => svc.listAlerts());
    const evidence = out.filter((a) => a.type === 'evidence_document_uploaded');
    expect(evidence.map((a) => a.needStatement)).toEqual([null, 'Stmt']);
  });

  it('gives roles with no queue nothing beyond their own survey alerts', async () => {
    const { svc } = setup();
    expect(await as('read_only_viewer', () => svc.listAlerts())).toEqual([]);
    expect(await as(undefined, () => svc.listAlerts()).catch(() => 'needs-actor')).toBeDefined();
  });
});
