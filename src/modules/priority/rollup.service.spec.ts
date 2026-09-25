import { describe, expect, it, vi } from 'vitest';
import { ScoreRollupService } from './rollup.service';

const settings = { minRespondentsForStandardConfidence: 2, dontKnowRatioThreshold: 0.5 };

const q = (id: string, over: Record<string, unknown> = {}) => ({
  questionId: id,
  questionText: `Text ${id}`,
  kpi: 'KPI1',
  indicator: 'IND1',
  subDomain: 'SUB1',
  domain: 'DOM1',
  measurementMode: 'SINGLE_SELECT',
  isScoreable: true,
  usedInMvp: true,
  ...over,
});

const score = (
  questionId: string,
  status: string,
  severity: number | null,
  reason: string | null = null,
) => ({
  questionId,
  scoreStatus: status,
  severityScore: severity,
  exclusionReason: reason,
});

function setup(
  over: { requiredSampleSize?: number | null; engine?: Record<string, unknown> } = {},
) {
  const store = new Map<string, Record<string, unknown>>();
  const key = (w: {
    studyId_surveyId_villageId_methodologyVersionId_rollupLevel_entityId: Record<string, string>;
  }) =>
    JSON.stringify(
      Object.values(w.studyId_surveyId_villageId_methodologyVersionId_rollupLevel_entityId),
    );
  const tx = {
    survey: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          id: 'sv1',
          orgId: 'org-1',
          needId: 'n1',
          methodologyVersion: 'v5.0',
          surveyQuestions: [],
        }),
    },
    surveyResponse: { findMany: vi.fn().mockResolvedValue([]) },
    responseAnswer: {
      deleteMany: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'a1' }),
      update: vi.fn(),
    },
    responseSeverityScore: {
      deleteMany: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    methodologyVersion: { findFirst: vi.fn().mockResolvedValue({ id: 'mv1' }) },
    scoringLookup: { findMany: vi.fn().mockResolvedValue([]) },
    study: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ requiredSampleSize: over.requiredSampleSize ?? null }),
    },
    question: { findMany: vi.fn().mockResolvedValue([]) },
    scoreRollup: {
      findUnique: vi.fn(async ({ where }: { where: never }) =>
        store.has(key(where)) ? { id: 'existing' } : null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.set(
          JSON.stringify([
            data.studyId,
            data.surveyId,
            data.villageId,
            data.methodologyVersionId,
            data.rollupLevel,
            data.entityId,
          ]),
          data,
        );
      }),
      update: vi.fn(),
    },
  };
  const tenant = {
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsOrg: async (_o: string, fn: (t: unknown) => unknown) => fn(tx),
  };
  const engine = {
    parseRawAnswerValue: vi
      .fn()
      .mockReturnValue({ optionId: 'OPT', optionIds: null, numericValue: null, text: null }),
    evaluateConditionalRule: vi.fn().mockReturnValue(true),
    getOptionExclusion: vi.fn().mockReturnValue(null),
    calculateSeverity: vi
      .fn()
      .mockReturnValue({
        score: 3,
        status: 'SCORED',
        exclusionReason: null,
        scoringLookupId: 'lk1',
      }),
    ...over.engine,
  };
  const priorityV2 = { recalculateAll: vi.fn().mockResolvedValue({ success: true }) };
  const methodologyConfig = {
    getRaw: vi.fn().mockResolvedValue({ confidenceFlagSettings: settings }),
  };
  const svc = new ScoreRollupService(
    tenant as never,
    engine as never,
    priorityV2 as never,
    methodologyConfig as never,
  );
  return { svc, tx, store, engine, priorityV2 };
}

describe('ScoreRollupService.calculateRollups', () => {
  it('rolls question scores up through KPI, indicator, sub-domain and domain to an overall index', async () => {
    const { svc, tx, store } = setup();
    tx.question.findMany.mockResolvedValue([
      q('Q1'),
      q('Q2'),
      q('Q3', { kpi: 'KPI2', indicator: 'IND2', subDomain: 'SUB2', domain: 'DOM2' }),
    ]);
    tx.responseSeverityScore.findMany.mockResolvedValue([
      score('Q1', 'SCORED', 2),
      score('Q1', 'SCORED', 4),
      score('Q1', 'EXCLUDED', null, 'DONT_KNOW'),
      score('Q2', 'SCORED', 6),
      score('Q2', 'SCORED', 6),
      score('Q3', 'NOT_APPLICABLE', null),
      score('Q-unknown', 'SCORED', 1),
    ]);
    await svc.calculateRollups('s1', 'sv1', null);
    const levels = [...store.values()].map((r) => r.rollupLevel);
    expect(new Set(levels)).toEqual(
      new Set(['QUESTION', 'KPI', 'INDICATOR', 'SUB_DOMAIN', 'DOMAIN', 'OVERALL']),
    );
    const q1 = [...store.values()].find((r) => r.entityId === 'Q1')!;
    expect(Number(q1.severityScore)).toBe(3);
    expect(q1.validResponseCount).toBe(2);
    const overall = [...store.values()].find((r) => r.rollupLevel === 'OVERALL')!;
    expect(overall.entityNameSnapshot).toBe('Village Development Needs Index');
    expect(Number(overall.severityScore)).toBeGreaterThan(0);
  });

  it('marks a rollup low-confidence for few respondents, many "don\'t know" answers or a short sample', async () => {
    const { svc, tx, store } = setup({ requiredSampleSize: 10 });
    tx.question.findMany.mockResolvedValue([q('Q1'), q('Q2')]);
    tx.responseSeverityScore.findMany.mockResolvedValue([
      score('Q1', 'SCORED', 2), // only one valid response
      score('Q2', 'SCORED', 3),
      score('Q2', 'SCORED', 3),
      score('Q2', 'EXCLUDED', null, 'DONT_KNOW'),
      score('Q2', 'EXCLUDED', null, 'DONT_KNOW'),
      score('Q2', 'EXCLUDED', null, 'DONT_KNOW'),
    ]);
    await svc.calculateRollups('s1', 'sv1', 'village-1');
    const byId = (id: string) => [...store.values()].find((r) => r.entityId === id)!;
    expect(byId('Q1').confidenceLevel).toBe('LOW');
    expect(byId('Q2').confidenceLevel).toBe('LOW');
    expect(tx.responseSeverityScore.findMany.mock.calls[0]![0].where.villageId).toBe('village-1');
  });

  it('marks a rollup standard when the sample is large enough and answers are clear', async () => {
    const { svc, tx, store } = setup({ requiredSampleSize: 2 });
    tx.question.findMany.mockResolvedValue([q('Q1')]);
    tx.responseSeverityScore.findMany.mockResolvedValue([
      score('Q1', 'SCORED', 2),
      score('Q1', 'SCORED', 4),
    ]);
    await svc.calculateRollups('s1', 'sv1', null);
    expect([...store.values()].find((r) => r.entityId === 'Q1')!.confidenceLevel).toBe('STANDARD');
  });

  it('updates existing rollups instead of creating duplicates', async () => {
    const { svc, tx } = setup();
    tx.question.findMany.mockResolvedValue([q('Q1')]);
    tx.responseSeverityScore.findMany.mockResolvedValue([
      score('Q1', 'SCORED', 2),
      score('Q1', 'SCORED', 2),
    ]);
    await svc.calculateRollups('s1', 'sv1', null);
    const created = tx.scoreRollup.create.mock.calls.length;
    await svc.calculateRollups('s1', 'sv1', null);
    expect(tx.scoreRollup.create).toHaveBeenCalledTimes(created);
    expect(tx.scoreRollup.update).toHaveBeenCalled();
  });

  it('handles levels with no scored children, and questions with no hierarchy', async () => {
    const { svc, tx, store } = setup();
    tx.question.findMany.mockResolvedValue([
      q('Q1'),
      q('Q2', { kpi: null, indicator: null, subDomain: null, domain: null }),
    ]);
    tx.responseSeverityScore.findMany.mockResolvedValue([
      score('Q1', 'EXCLUDED', null, 'DONT_KNOW'),
      score('Q2', 'SCORED', 5),
    ]);
    await svc.calculateRollups('s1', 'sv1', null);
    const overall = [...store.values()].find((r) => r.rollupLevel === 'OVERALL')!;
    expect(overall.severityScore).toBeNull();
    expect([...store.values()].some((r) => r.entityId === 'Q2')).toBe(true);
  });

  it('writes no overall rollup when nothing rolls up', async () => {
    const { svc, tx, store } = setup();
    tx.question.findMany.mockResolvedValue([
      q('Q1', { kpi: null, indicator: null, subDomain: null, domain: null }),
    ]);
    tx.responseSeverityScore.findMany.mockResolvedValue([score('Q1', 'SCORED', 5)]);
    await svc.calculateRollups('s1', 'sv1', null);
    expect([...store.values()].some((r) => r.rollupLevel === 'OVERALL')).toBe(false);
  });

  it('does nothing without a survey or a methodology version', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValueOnce(null);
    await svc.calculateRollups('s1', 'x', null);
    tx.methodologyVersion.findFirst.mockResolvedValueOnce(null);
    tx.survey.findUnique.mockResolvedValueOnce({
      id: 'sv1',
      orgId: 'org-1',
      methodologyVersion: null,
    });
    await svc.calculateRollups('s1', 'sv1', null);
    expect(tx.scoreRollup.create).not.toHaveBeenCalled();
  });

  it("runs inside a caller's transaction, an organization context, or its own", async () => {
    const { svc, tx } = setup();
    await svc.calculateRollups('s1', 'sv1', null, { tx: tx as never });
    await svc.calculateRollups('s1', 'sv1', null, { orgId: 'org-1' });
    await svc.calculateRollups('s1', 'sv1', null);
    expect(tx.survey.findUnique).toHaveBeenCalledTimes(3);
  });
});

describe('ScoreRollupService.recalculateStudyScores', () => {
  const survey = (over: Record<string, unknown> = {}) => ({
    id: 'sv1',
    orgId: 'org-1',
    needId: 'n1',
    methodologyVersion: 'v5.0',
    surveyQuestions: [
      { id: 'sq1', question: q('Q1') },
      { id: 'sq2', question: null },
    ],
    ...over,
  });
  const response = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    orgId: 'org-1',
    contact: 'c@x',
    submittedAt: new Date(),
    answers: { sq1: 'a' },
    need: { village: ['V1'] },
    ...over,
  });

  it('reports why nothing was recalculated', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValueOnce(null);
    expect(await svc.recalculateStudyScores('s1', 'x')).toEqual({
      success: false,
      reason: 'SURVEY_NOT_FOUND',
    });
    tx.survey.findUnique.mockResolvedValueOnce(survey());
    expect(await svc.recalculateStudyScores('s1', 'sv1')).toEqual({
      success: false,
      reason: 'NO_RESPONSES',
    });
    tx.survey.findUnique.mockResolvedValueOnce(survey());
    tx.surveyResponse.findMany.mockResolvedValueOnce([response()]);
    tx.methodologyVersion.findFirst.mockResolvedValueOnce(null);
    expect(await svc.recalculateStudyScores('s1', 'sv1')).toEqual({
      success: false,
      reason: 'NO_METHODOLOGY_VERSION',
    });
  });

  it('scores each answer, records why others are not scored, then rolls up and recalculates priorities', async () => {
    const { svc, tx, engine, priorityV2 } = setup();
    tx.survey.findUnique.mockResolvedValue(
      survey({
        surveyQuestions: [1, 2, 3, 4, 5].map((n) => ({
          id: `sq${n}`,
          question: q(`Q${n}`, n === 3 ? { isScoreable: false } : {}),
        })),
      }),
    );
    tx.surveyResponse.findMany.mockResolvedValue([
      response({ answers: { sq1: 'a', sq2: 'b', sq3: 'c', sq4: '', sq5: 'e' } }),
    ]);
    tx.methodologyVersion.findFirst.mockResolvedValue({ id: 'mv1' });
    engine.parseRawAnswerValue.mockImplementation((raw: unknown) =>
      raw === ''
        ? { optionId: null, optionIds: null, numericValue: null, text: null }
        : { optionId: 'OPT', optionIds: ['OPT'], numericValue: 2, text: 'x' },
    );
    engine.evaluateConditionalRule.mockImplementation(
      (question: { questionId: string }) => question.questionId !== 'Q2',
    );
    engine.getOptionExclusion.mockImplementation((_o: unknown, _l: unknown, qId: string) =>
      qId === 'Q5' ? { lookupId: 'lk', exclusionReason: 'DONT_KNOW' } : null,
    );
    const result = await svc.recalculateStudyScores('s1', 'sv1');
    expect(result).toEqual({ success: true });
    expect(priorityV2.recalculateAll).toHaveBeenCalledWith('s1', 'sv1');
    const statuses = tx.responseSeverityScore.create.mock.calls.map((c) => [
      c[0].data.questionId,
      c[0].data.scoreStatus,
      c[0].data.exclusionReason,
    ]);
    expect(statuses).toEqual(
      expect.arrayContaining([
        ['Q2', 'NOT_APPLICABLE', undefined],
        ['Q3', 'NOT_SCOREABLE', undefined],
        ['Q4', 'EXCLUDED', 'MISSING_ANSWER'],
        ['Q5', 'EXCLUDED', 'DONT_KNOW'],
        ['Q1', 'SCORED', null],
      ]),
    );
    expect(tx.responseAnswer.update).toHaveBeenCalled();
    expect(tx.responseAnswer.deleteMany).toHaveBeenCalled();
  });

  it('records a scoring error when no lookup matches, and scores a need with no village once', async () => {
    const { svc, tx, engine } = setup();
    tx.survey.findUnique.mockResolvedValue(
      survey({ surveyQuestions: [{ id: 'sq1', question: q('Q1') }] }),
    );
    tx.surveyResponse.findMany.mockResolvedValue([
      response({ need: { village: [] }, answers: null }),
    ]);
    engine.calculateSeverity.mockImplementation(() => {
      throw new Error('no lookup');
    });
    await svc.recalculateStudyScores('s1', 'sv1');
    const created = tx.responseSeverityScore.create.mock.calls.map((c) => c[0].data);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      scoreStatus: 'ERROR',
      exclusionReason: 'MISSING_LOOKUP',
      villageId: null,
    });
  });

  it('uses the published methodology version when the survey names none', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValue(survey({ methodologyVersion: null }));
    tx.surveyResponse.findMany.mockResolvedValue([response()]);
    await svc.recalculateStudyScores('s1', 'sv1');
    expect(tx.methodologyVersion.findFirst.mock.calls[0]![0].where).toEqual({
      status: 'PUBLISHED',
    });
  });
});
