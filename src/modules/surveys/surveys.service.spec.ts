import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { SurveysService } from './surveys.service';
import { orgContext } from '../../tenancy/org-context';

// Minimal local shape — only the fields this file's tests read/write.
interface FakeSurvey {
  id: string;
  needId?: string;
  status: string;
  rejectionReasonCode?: string | null;
  approverComments?: string | null;
  methodologyVersion?: string | null;
  targetGroup?: string | null;
  expectedSampleSize?: number | null;
  selectionApproach?: string | null;
  geographicCoverage?: string | null;
}

function fakeTenant(survey: FakeSurvey | null, questionCount = 1) {
  // A local clone, mutated in place as `update` is called — isolates each
  // makeService() call's state even when tests share a fixture object
  // literal, and lets a later getSurveyByNeedId (its own separate
  // runInOrgContext call, inside the same service instance) see writes
  // from an earlier update within the same test.
  let current = survey ? { ...survey } : null;
  const tx = {
    survey: {
      findUnique: async () => current,
      findFirst: async () => (current ? { ...current, surveyQuestions: [] } : null),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (current) current = { ...current, ...data };
        return current;
      },
    },
    surveyQuestion: {
      count: async () => questionCount,
    },
    user: {
      findMany: async () => [],
    },
    // approveAndPublish also moves the owning Need to survey_published —
    // this file's tests don't assert on Need state, just need the call to
    // resolve.
    need: {
      update: async () => undefined,
    },
  };
  return {
    runInOrgContext: async (fn: (tx: unknown) => unknown) => fn(tx),
    runAsSupervisor: async (fn: (tx: unknown) => unknown) => fn(tx),
  };
}

function makeService(survey: FakeSurvey | null, questionCount = 1) {
  const audit = { record: async () => undefined };
  // These tests never touch ai/methodologyConfig — undefined stand-ins are
  // enough, matching this file's narrow scope (rejectSurvey, submitForApproval,
  // setSampleDescription — none of them call either dependency).
  return new SurveysService(fakeTenant(survey, questionCount) as never, audit as never, undefined as never, undefined as never);
}

function runAsApprover<T>(fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: 'r1', actorId: 'approver-1', role: 'human_reviewer' }, fn);
}

describe('SurveysService.rejectSurvey', () => {
  const submittedSurvey: FakeSurvey = { id: 'sv1', status: 'SUBMITTED' };

  it('requires comments regardless of reason code — rejects with empty comments', async () => {
    const service = makeService(submittedSurvey);
    await expect(runAsApprover(() => service.rejectSurvey('sv1', 'REJ_03', ''))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blank/whitespace-only comments still fail, for any reason code', async () => {
    const service = makeService(submittedSurvey);
    await expect(runAsApprover(() => service.rejectSurvey('sv1', 'REJ_99', '   '))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REJ_99 ("Other") with real comments succeeds', async () => {
    const service = makeService(submittedSurvey);
    const result = (await runAsApprover(() => service.rejectSurvey('sv1', 'REJ_99', 'Explanation here'))) as FakeSurvey;
    expect(result.status).toBe('REJECTED');
    expect(result.rejectionReasonCode).toBe('REJ_99');
    expect(result.approverComments).toBe('Explanation here');
  });

  it('a specific reason code (not REJ_99) also requires real comments', async () => {
    const service = makeService(submittedSurvey);
    const result = (await runAsApprover(() => service.rejectSurvey('sv1', 'REJ_06', 'Extra context'))) as FakeSurvey;
    expect(result.rejectionReasonCode).toBe('REJ_06');
    expect(result.approverComments).toBe('Extra context');
  });

  it('rejects a survey that is not currently SUBMITTED', async () => {
    const service = makeService({ id: 'sv1', status: 'DRAFT' });
    await expect(runAsApprover(() => service.rejectSurvey('sv1', 'REJ_01', 'Some notes'))).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('SurveysService.approveAndPublish', () => {
  const submittedSurvey: FakeSurvey = { id: 'sv1', needId: 'n1', status: 'SUBMITTED' };
  const draftSurvey: FakeSurvey = { id: 'sv1', needId: 'n1', status: 'DRAFT' };

  it('requires reviewer notes — rejects with empty comments', async () => {
    const service = makeService(submittedSurvey);
    await expect(runAsApprover(() => service.approveAndPublish('sv1', ''))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blank/whitespace-only reviewer notes still fail', async () => {
    const service = makeService(submittedSurvey);
    await expect(runAsApprover(() => service.approveAndPublish('sv1', '   '))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('succeeds with real reviewer notes — persists approverComments and publishes', async () => {
    const service = makeService(submittedSurvey);
    const result = (await runAsApprover(() => service.approveAndPublish('sv1', 'Looks good, publishing.'))) as FakeSurvey;
    expect(result.status).toBe('PUBLISHED');
    expect(result.approverComments).toBe('Looks good, publishing.');
  });

  it('also succeeds from DRAFT (the AI Review flow, no separate submit step)', async () => {
    const service = makeService(draftSurvey);
    const result = (await runAsApprover(() => service.approveAndPublish('sv1', 'Approved via AI Review.'))) as FakeSurvey;
    expect(result.status).toBe('PUBLISHED');
    expect(result.approverComments).toBe('Approved via AI Review.');
  });

  it('rejects a survey that is not currently SUBMITTED or DRAFT', async () => {
    const service = makeService({ id: 'sv1', needId: 'n1', status: 'REJECTED' });
    await expect(runAsApprover(() => service.approveAndPublish('sv1', 'Notes'))).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('SurveysService.submitForApproval', () => {
  const complete: FakeSurvey = {
    id: 'sv1',
    needId: 'n1',
    status: 'DRAFT',
    methodologyVersion: 'v1.0',
    targetGroup: 'Households with children under 5',
    expectedSampleSize: 400,
    selectionApproach: 'Random sampling',
    geographicCoverage: 'Riyadh',
  };

  it('succeeds with Sample Description entirely missing — it is optional, unlike Methodology Version', async () => {
    const service = makeService({ ...complete, targetGroup: null, expectedSampleSize: null, selectionApproach: null, geographicCoverage: null });
    const result = (await runAsApprover(() => service.submitForApproval('sv1'))) as FakeSurvey;
    expect(result.status).toBe('SUBMITTED');
  });

  it('succeeds once Methodology Version and every Sample Description field are set', async () => {
    const service = makeService({ ...complete });
    const result = (await runAsApprover(() => service.submitForApproval('sv1'))) as FakeSurvey;
    expect(result.status).toBe('SUBMITTED');
  });
});

describe('SurveysService.setSampleDescription', () => {
  it('persists all four fields together', async () => {
    const service = makeService({ id: 'sv1', needId: 'n1', status: 'DRAFT' });
    const result = (await runAsApprover(() =>
      service.setSampleDescription('sv1', 'Small business owners', 250, 'Convenience sampling', 'Eastern Province'),
    )) as unknown as FakeSurvey;
    expect(result.targetGroup).toBe('Small business owners');
    expect(result.expectedSampleSize).toBe(250);
    expect(result.selectionApproach).toBe('Convenience sampling');
    expect(result.geographicCoverage).toBe('Eastern Province');
  });

  it('is blocked once the survey is no longer editable (SUBMITTED)', async () => {
    const service = makeService({ id: 'sv1', needId: 'n1', status: 'SUBMITTED' });
    await expect(
      runAsApprover(() => service.setSampleDescription('sv1', 'Group', 100, 'Approach', 'Coverage')),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // Client clarification (Aug 11, confirmed): Survey-level Expected Size
  // must never auto-populate from, or write back to, the Study's own
  // calculated Sample Size — the two are independent values the NGO can
  // legitimately set differently (e.g. targeting a sub-group).
  it('RIO-FR-011/RIO-FR-024: Expected Size is independent of the Study — the write path has no Study model to touch at all', async () => {
    // fakeTenant's tx intentionally has no `study` key (see its definition
    // above) — if setSampleDescription ever tried to read/write a Study
    // row, this test would throw "tx.study is undefined" rather than
    // silently pass, so the absence of that error is itself the proof of
    // independence, not just an assumption.
    const service = makeService({ id: 'sv1', needId: 'n1', status: 'DRAFT' });
    const result = (await runAsApprover(() =>
      service.setSampleDescription('sv1', 'Households with under-5 children', 180, 'Cluster sampling', 'Ad-Dilam'),
    )) as unknown as FakeSurvey;
    expect(result.expectedSampleSize).toBe(180);
  });

  it("Expected Size can legitimately differ from what a Study's own calculation would produce — no clamping/overwriting to a 'correct' value", async () => {
    const service = makeService({ id: 'sv1', needId: 'n1', status: 'DRAFT' });
    // An NGO targeting a specific sub-group within the calculated sample —
    // an arbitrary, unrelated number is accepted as-is.
    const result = (await runAsApprover(() =>
      service.setSampleDescription('sv1', 'Female-headed households only', 45, 'Purposive sampling', 'Al-Jumum North'),
    )) as unknown as FakeSurvey;
    expect(result.expectedSampleSize).toBe(45);
  });

  it('editing Expected Size again overwrites only the Survey row — re-saving with a new value never reintroduces an old one', async () => {
    const service = makeService({ id: 'sv1', needId: 'n1', status: 'DRAFT', expectedSampleSize: 250 });
    const result = (await runAsApprover(() =>
      service.setSampleDescription('sv1', 'Households with under-5 children', 90, 'Cluster sampling', 'Ad-Dilam'),
    )) as unknown as FakeSurvey;
    expect(result.expectedSampleSize).toBe(90);
  });
});

describe('SurveysService.listReusableCustomQuestions', () => {
  interface FakeSurveyQuestionRow {
    id: string;
    customText: string | null;
    customAnswerType: string | null;
    customOptions: unknown;
    domain: string | null;
    subDomain: string | null;
    kpi: string | null;
    survey: { title: string };
  }

  function makeQuestionService(rows: FakeSurveyQuestionRow[]) {
    const tenant = {
      runInOrgContext: async (fn: (tx: unknown) => unknown) =>
        fn({
          surveyQuestion: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
              rows.filter((r) => (where.domain ? r.domain === where.domain && r.subDomain === where.subDomain : true)),
          },
        }),
    };
    const audit = { record: async () => undefined };
    return new SurveysService(tenant as never, audit as never, undefined as never, undefined as never);
  }

  const rows: FakeSurveyQuestionRow[] = [
    {
      id: 'q1', customText: 'Any water source issues?', customAnswerType: 'long_text', customOptions: null,
      domain: 'Water & Sanitation', subDomain: 'Drinking Water Access', kpi: null, survey: { title: 'Survey A' },
    },
    {
      id: 'q2', customText: 'Describe school access.', customAnswerType: 'long_text', customOptions: null,
      domain: 'Education', subDomain: 'Access to Basic Education', kpi: null, survey: { title: 'Survey B' },
    },
  ];

  it('filters to the given domain/subDomain when both are provided', async () => {
    const service = makeQuestionService(rows);
    const result = await runAsApprover(() => service.listReusableCustomQuestions('Water & Sanitation', 'Drinking Water Access'));
    expect(result).toHaveLength(1);
    expect(result[0]?.questionText).toBe('Any water source issues?');
  });

  it('returns every reusable custom question when called with no domain/subDomain (allDomainsSelected)', async () => {
    const service = makeQuestionService(rows);
    const result = await runAsApprover(() => service.listReusableCustomQuestions());
    expect(result).toHaveLength(2);
  });
});
