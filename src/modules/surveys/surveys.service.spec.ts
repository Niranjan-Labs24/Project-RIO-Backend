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

  it('REJ_99 ("Other") requires comments — rejects with no comments', async () => {
    const service = makeService(submittedSurvey);
    await expect(runAsApprover(() => service.rejectSurvey('sv1', 'REJ_99'))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REJ_99 ("Other") with blank/whitespace-only comments still fails', async () => {
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

  it('a specific reason code (not REJ_99) succeeds with no comments at all', async () => {
    const service = makeService(submittedSurvey);
    const result = (await runAsApprover(() => service.rejectSurvey('sv1', 'REJ_03'))) as FakeSurvey;
    expect(result.status).toBe('REJECTED');
    expect(result.rejectionReasonCode).toBe('REJ_03');
    expect(result.approverComments).toBeNull();
  });

  it('a specific reason code (not REJ_99) also accepts optional comments', async () => {
    const service = makeService(submittedSurvey);
    const result = (await runAsApprover(() => service.rejectSurvey('sv1', 'REJ_06', 'Extra context'))) as FakeSurvey;
    expect(result.rejectionReasonCode).toBe('REJ_06');
    expect(result.approverComments).toBe('Extra context');
  });

  it('rejects a survey that is not currently SUBMITTED', async () => {
    const service = makeService({ id: 'sv1', status: 'DRAFT' });
    await expect(runAsApprover(() => service.rejectSurvey('sv1', 'REJ_01'))).rejects.toBeInstanceOf(ConflictException);
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
});
