import { describe, expect, it, vi } from 'vitest';
import { orgContext, type OrgStore } from '../../tenancy/org-context';
import { SurveyQualityService } from './survey-quality.service';

// UAT DQ-05 — one row per published survey: completeness, anomalies and the
// confidence flag of its responses.

const survey = (over: Record<string, unknown> = {}) => ({
  id: 'sv1',
  needId: 'n1',
  studyId: 'st1',
  surveyQuestions: [
    { id: 'q1', isRequired: true },
    { id: 'q2', isRequired: true },
    { id: 'q3', isRequired: false },
  ],
  need: { internalRefSeq: 7, title: 'No clinic' },
  study: { title: 'Health study', requiredSampleSize: null },
  ...over,
});

function setup(opts: {
  surveys?: Record<string, unknown>[];
  responses?: Record<string, unknown>[];
  rollups?: Record<string, unknown>[];
  flags?: Record<string, unknown>[];
  duplicates?: Record<string, unknown>[];
  versions?: Record<string, unknown>[];
}) {
  const tx = {
    survey: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(opts.surveys ?? [survey()])
        .mockResolvedValue(opts.versions ?? opts.surveys ?? [survey()]),
    },
    surveyResponse: { findMany: vi.fn().mockResolvedValue(opts.responses ?? []) },
    scoreRollup: { findMany: vi.fn().mockResolvedValue(opts.rollups ?? []) },
    cleaningFlag: { groupBy: vi.fn().mockResolvedValue(opts.flags ?? []) },
    responseQualityResult: { findMany: vi.fn().mockResolvedValue(opts.duplicates ?? []) },
  };
  const used: string[] = [];
  const tenant = {
    runInOrgContext: async (fn: (t: unknown) => unknown) => (used.push('org'), fn(tx)),
    runAsSupervisor: async (fn: (t: unknown) => unknown) => (used.push('supervisor'), fn(tx)),
  };
  const config = {
    getRaw: vi.fn().mockResolvedValue({
      confidenceFlagSettings: { minRespondentsForStandardConfidence: 2, dontKnowRatioThreshold: 0.2 },
    }),
  };
  return { tx, used, svc: new SurveyQualityService(tenant as never, config as never) };
}

const asRole = <T>(role: string, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role } as OrgStore, fn);

describe('SurveyQualityService.list', () => {
  it('measures completeness on required questions, counts anomalies and flags low confidence', async () => {
    const { svc } = setup({
      responses: [
        { id: 'r1', needId: 'n1', answers: { q1: 'yes', q2: 'no' }, exclusionReason: null },
        { id: 'r2', needId: 'n1', answers: { q1: '', q2: null, q3: 'x' }, exclusionReason: null },
        { id: 'r3', needId: 'n1', answers: {}, exclusionReason: 'duplicate' },
      ],
      flags: [{ entityId: 'r2', _count: { _all: 3 } }],
      duplicates: [{ surveyResponseId: 'r1' }],
    });
    const [row] = await asRole('ngo_admin', () => svc.list());

    expect(row).toMatchObject({
      needReferenceId: 'NEED-000007',
      responseCount: 2,
      excludedCount: 1,
      completenessPct: 50, // r1 2/2, r2 0/2
      openFindings: 3,
      possibleDuplicates: 1,
      dontKnowPct: null,
      scored: false,
      confidence: 'STANDARD', // 2 respondents meets the configured minimum of 2
    });
  });

  it('uses the scoring roll-up when the survey has been scored', async () => {
    const { svc } = setup({
      responses: [
        { id: 'r1', needId: 'n1', answers: { q1: 'a', q2: 'b' }, exclusionReason: null },
        { id: 'r2', needId: 'n1', answers: { q1: 'a', q2: 'b' }, exclusionReason: null },
      ],
      rollups: [{ surveyId: 'sv1', dontKnowRate: '0.25', confidenceLevel: 'LOW' }],
    });
    const [row] = await asRole('ngo_admin', () => svc.list());
    expect(row).toMatchObject({
      dontKnowPct: 25,
      scored: true,
      confidence: 'LOW',
      confidenceReasons: ['high_dont_know'],
    });
  });

  it('flags too few respondents and a missed required sample, and shows only the latest survey per need', async () => {
    const { svc } = setup({
      surveys: [
        survey({ id: 'sv2', study: { title: 'Health study', requiredSampleSize: 30 } }),
        survey({ id: 'sv1' }), // an older version of the same need's survey
      ],
      responses: [{ id: 'r1', needId: 'n1', answers: {}, exclusionReason: null }],
    });
    const rows = await asRole('ngo_admin', () => svc.list());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      surveyId: 'sv2',
      completenessPct: 0,
      confidence: 'LOW',
      confidenceReasons: ['few_respondents', 'below_required_sample'],
    });
  });

  it('measures each response against the survey version it was answered on', async () => {
    const { svc } = setup({
      surveys: [survey({ id: 'sv2', surveyQuestions: [{ id: 'new1', isRequired: true }] })],
      versions: [
        survey({ id: 'sv2', surveyQuestions: [{ id: 'new1', isRequired: true }] }),
        survey({ id: 'sv1' }),
      ],
      responses: [{ id: 'r1', needId: 'n1', answers: { q1: 'a', q2: 'b' }, exclusionReason: null }],
    });
    const [row] = await asRole('ngo_admin', () => svc.list());
    expect(row).toMatchObject({ surveyId: 'sv2', completenessPct: 100 });
  });

  it('reads across organizations for a platform role, and returns nothing without published surveys', async () => {
    const { svc, used, tx } = setup({ surveys: [] });
    expect(await asRole('system_admin', () => svc.list('st1'))).toEqual([]);
    expect(used).toEqual(['supervisor']);
    expect(tx.survey.findMany.mock.calls[0]![0].where).toMatchObject({
      status: 'PUBLISHED',
      studyId: 'st1',
    });
    expect(tx.surveyResponse.findMany).not.toHaveBeenCalled();
  });
});
