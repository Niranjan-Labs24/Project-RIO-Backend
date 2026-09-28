import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../tenancy/org-context';
import {
  DEFAULT_PRIORITY_FACTOR_SCALES,
  DEFAULT_PRIORITY_FACTOR_WEIGHTS,
  DEFAULT_PRIORITY_THRESHOLDS,
} from '../methodology-config/methodology-config.service';
import { PriorityService } from './priority.service';

const asActor = <T>(fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1' }, fn);

const scoreRow = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  needId: 'n1',
  studyId: 's1',
  surveyLinkId: null,
  overallScore: 70,
  overrideScore: null,
  overrideReason: null,
  overriddenAt: null as Date | null,
  level: 'high',
  gapType: 'acute',
  factors: {},
  cycleNote: null,
  scoredAt: new Date('2026-03-01T00:00:00Z'),
  approvedAt: null as Date | null,
  ...over,
});

function setup() {
  const tx = {
    need: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          id: 'n1',
          studyId: 's1',
          themes: ['water'],
          affectedPeople: 100,
          urgency: 'high',
          village: ['A', 'B'],
          domain: 'Water',
          gapType: null,
        }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    publicSurveyLink: { findUnique: vi.fn().mockResolvedValue({ id: 'l1', needId: 'n1' }) },
    survey: {
      findFirst: vi.fn().mockResolvedValue({ id: 'sv1', methodologyVersion: 'v5.0' }),
      findUnique: vi.fn().mockResolvedValue({ methodologyVersion: 'v5.0' }),
    },
    methodologyVersion: {
      findFirst: vi.fn().mockResolvedValue({ id: 'mv1', version: 'v5.0' }),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'new' }),
      findUnique: vi.fn().mockResolvedValue({ id: 'mv1' }),
    },
    scoreRollup: {
      findFirst: vi.fn().mockResolvedValue({ severityScore: 3.5, dontKnowRate: 0.1 }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    question: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    responseSeverityScore: { findMany: vi.fn().mockResolvedValue([]) },
    responseAnswer: { findMany: vi.fn().mockResolvedValue([]) },
    scoringLookup: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
    priorityScore: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    study: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const tenant = {
    runRead: async (fn: (t: unknown) => unknown) => fn(tx),
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  const methodologyConfig = {
    getRaw: vi.fn().mockResolvedValue({
      priorityThresholds: DEFAULT_PRIORITY_THRESHOLDS,
      priorityFactorWeights: DEFAULT_PRIORITY_FACTOR_WEIGHTS,
      priorityFactorScales: DEFAULT_PRIORITY_FACTOR_SCALES,
    }),
  };
  const themes = { countSharingThemes: vi.fn().mockResolvedValue(2) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  tx.priorityScore.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    scoreRow({ ...data, id: 'new' }),
  );
  return {
    tx,
    methodologyConfig,
    audit,
    svc: new PriorityService(
      tenant as never,
      methodologyConfig as never,
      themes as never,
      audit as never,
    ),
  };
}

describe('PriorityService.score', () => {
  it('computes and stores a consolidated score from the rollups', async () => {
    const { svc, tx } = setup();
    tx.question.findMany.mockResolvedValue([{ questionId: 'q1' }]);
    tx.scoreRollup.findMany.mockResolvedValue([
      { entityId: 'q1', severityScore: 4 },
      { entityId: 'q2', severityScore: null },
    ]);
    const score = await asActor(() => svc.score('n1'));
    expect(score.needId).toBe('n1');
    const data = tx.priorityScore.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ orgId: 'org-1', gapType: 'acute', surveyLinkId: null });
    expect(['critical', 'high', 'medium', 'low']).toContain(data.level);
    expect(data.factors).toMatchObject({ model: 'nine-factor-weighted-mean' });
  });

  it('scores for one survey link, and scores with no rollup data at all', async () => {
    const { svc, tx } = setup();
    tx.scoreRollup.findFirst.mockResolvedValue(null);
    tx.methodologyVersion.findFirst.mockResolvedValue(null);
    tx.survey.findFirst.mockResolvedValue({ id: 'sv1', methodologyVersion: null });
    await asActor(() => svc.score('n1', 'l1'));
    expect(tx.priorityScore.create.mock.calls[0]![0].data.surveyLinkId).toBe('l1');
    expect(tx.scoreRollup.findMany).not.toHaveBeenCalled();
  });

  it('flags equity when segments differ a lot, ignoring small segments', async () => {
    const { svc, tx } = setup();
    const rows = (gender: string, ageBracket: string | null, severityScore: unknown, n: number) =>
      Array.from({ length: n }, () => ({ severityScore, surveyResponse: { gender, ageBracket } }));
    tx.responseSeverityScore.findMany.mockResolvedValue([
      ...rows('female', null, 90, 6),
      ...rows('male', null, 10, 6),
      ...rows('other', '65+', 5, 2),
      { severityScore: 'NaN', surveyResponse: { gender: 'female', ageBracket: null } },
      { severityScore: 3, surveyResponse: null },
    ]);
    await asActor(() => svc.score('n1'));
    const data = tx.priorityScore.create.mock.calls[0]![0].data;
    expect(data.equityFlagged).toBe(true);
  });

  it('does not flag equity with fewer than two large segments', async () => {
    const { svc, tx } = setup();
    tx.responseSeverityScore.findMany.mockResolvedValue(
      Array.from({ length: 6 }, () => ({
        severityScore: 5,
        surveyResponse: { gender: 'female', ageBracket: null },
      })),
    );
    await asActor(() => svc.score('n1'));
    expect(tx.priorityScore.create.mock.calls[0]![0].data.equityFlagged).toBe(false);
  });

  it('404s an unknown need, a foreign survey link, and a need with no published survey', async () => {
    const { svc, tx } = setup();
    tx.need.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.score('x'))).rejects.toMatchObject({
      response: { error: { code: 'NEED_NOT_FOUND' } },
    });
    tx.publicSurveyLink.findUnique.mockResolvedValueOnce({ id: 'l1', needId: 'other' });
    await expect(asActor(() => svc.score('n1', 'l1'))).rejects.toMatchObject({
      response: { error: { code: 'SURVEY_LINK_NOT_FOUND' } },
    });
    tx.publicSurveyLink.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.score('n1', 'l1'))).rejects.toBeInstanceOf(NotFoundException);
    tx.survey.findFirst.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.score('n1'))).rejects.toMatchObject({
      response: { error: { code: 'SURVEY_NOT_FOUND' } },
    });
  });

  it('falls back to default thresholds when the configuration cannot be read or is partial', async () => {
    const { svc, methodologyConfig, tx } = setup();
    methodologyConfig.getRaw.mockRejectedValueOnce(new Error('cfg'));
    await asActor(() => svc.score('n1')); // thresholds fail and default; weights are read again and succeed
    methodologyConfig.getRaw.mockResolvedValueOnce({
      priorityThresholds: {},
      priorityFactorWeights: DEFAULT_PRIORITY_FACTOR_WEIGHTS,
      priorityFactorScales: DEFAULT_PRIORITY_FACTOR_SCALES,
    });
    await asActor(() => svc.score('n1'));
    expect(tx.priorityScore.create).toHaveBeenCalledTimes(2);
  });
});

describe('PriorityService approve, override and reads', () => {
  it('approves a score', async () => {
    const { svc, tx } = setup();
    tx.priorityScore.update.mockResolvedValue(
      scoreRow({ approvedAt: new Date('2026-03-02T00:00:00Z') }),
    );
    const score = await asActor(() => svc.approve('p1'));
    expect(score).toMatchObject({ isApproved: true, approvedAt: '2026-03-02T00:00:00.000Z' });
    expect(tx.priorityScore.update.mock.calls[0]![0].data.approvedBy).toBe('u1');
  });

  it('overrides an unapproved score with a reason and audits it', async () => {
    const { svc, tx, audit } = setup();
    tx.priorityScore.findUnique.mockResolvedValue(scoreRow());
    tx.priorityScore.update.mockResolvedValue(
      scoreRow({
        overrideScore: 85,
        overrideReason: 'Field report',
        overriddenAt: new Date('2026-03-03T00:00:00Z'),
      }),
    );
    const score = await asActor(() => svc.override('p1', 84.6, '  Field report  '));
    expect(tx.priorityScore.update.mock.calls[0]![0].data).toMatchObject({
      overrideScore: 85,
      overrideReason: 'Field report',
    });
    expect(score).toMatchObject({
      effectiveScore: 85,
      computedScore: 70,
      overriddenAt: '2026-03-03T00:00:00.000Z',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'override_priority_score' }),
    );
  });

  it('refuses an empty reason, an unknown score and an approved score', async () => {
    const { svc, tx } = setup();
    await expect(asActor(() => svc.override('p1', 50, '   '))).rejects.toMatchObject({
      response: { error: { code: 'PRIORITY_OVERRIDE_REASON_REQUIRED' } },
    });
    tx.priorityScore.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.override('p1', 50, 'r'))).rejects.toMatchObject({
      response: { error: { code: 'PRIORITY_SCORE_NOT_FOUND' } },
    });
    tx.priorityScore.findUnique.mockResolvedValueOnce(scoreRow({ approvedAt: new Date() }));
    await expect(asActor(() => svc.override('p1', 50, 'r'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns the latest score for a need or one of its links, or null', async () => {
    const { svc, tx } = setup();
    tx.priorityScore.findFirst.mockResolvedValueOnce(scoreRow());
    expect((await svc.getLatest('n1'))!.id).toBe('p1');
    tx.priorityScore.findFirst.mockResolvedValueOnce(null);
    expect(await svc.getLatest('n1', 'l1')).toBeNull();
    expect(tx.priorityScore.findFirst.mock.calls[1]![0].where.surveyLinkId).toBe('l1');
  });

  it('lists every need with its latest consolidated score', async () => {
    const { svc, tx } = setup();
    tx.study.findMany.mockResolvedValue([{ id: 's1', title: 'Study' }]);
    tx.need.findMany.mockResolvedValue([
      { id: 'n1', studyId: 's1', gapType: 'acute', themes: ['w'], urgency: 'high' },
      { id: 'n2', studyId: 's-unknown', gapType: null, themes: null, urgency: null },
    ]);
    tx.priorityScore.findMany.mockResolvedValue([scoreRow({ id: 'new' }), scoreRow({ id: 'old' })]);
    const entries = await svc.listForOrg();
    expect(entries[0]).toMatchObject({
      studyTitle: 'Study',
      score: { id: 'new', source: 'priorityScore' },
    });
    expect(entries[1]).toMatchObject({
      studyTitle: 's-unknown',
      themes: [],
      urgency: null,
      score: null,
    });
  });
});

describe('PriorityService methodology versions and lookups', () => {
  it('lists and creates methodology versions', async () => {
    const { svc, tx } = setup();
    await svc.listMethodologyVersions();
    await asActor(() => svc.createMethodologyVersion({ name: 'v6', version: '6.0' }));
    expect(tx.methodologyVersion.create.mock.calls[0]![0].data).toMatchObject({
      description: null,
      createdBy: 'u1',
    });
    await asActor(() =>
      svc.createMethodologyVersion({ name: 'v6', version: '6.0', description: 'd' }),
    );
  });

  it('imports scoring lookups, updating existing rows and skipping incomplete ones', async () => {
    const { svc, tx } = setup();
    tx.scoringLookup.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'existing' });
    const csv = [
      'header',
      'x,Q1,SCORE,OPT_A,1,2.5,,,HIGH,true,Because "quoted, here"',
      'x,Q2,NUMERIC,,,,0,10,,false,',
      'x,,SCORE,A',
      '',
      'x,Q1,SCORE,OPT_B,2,"1.5",,,,,',
    ].join('\r\n');
    expect(await svc.uploadLookups('mv1', csv)).toEqual({ imported: 3 });
    expect(tx.scoringLookup.create).toHaveBeenCalledTimes(2);
    expect(tx.scoringLookup.update).toHaveBeenCalledTimes(1);
    expect(tx.scoringLookup.create.mock.calls[0]![0].data).toMatchObject({
      isExcluded: true,
      exclusionReason: 'Because quoted, here',
      severityScore: 2.5,
    });
  });

  it('refuses lookups for an unknown methodology version', async () => {
    const { svc, tx } = setup();
    tx.methodologyVersion.findUnique.mockResolvedValue(null);
    await expect(svc.uploadLookups('x', 'h')).rejects.toMatchObject({
      response: { error: { code: 'METHODOLOGY_NOT_FOUND' } },
    });
  });
});

describe('PriorityService dashboards', () => {
  const rollup = (over: Record<string, unknown> = {}) => ({
    entityId: 'e1',
    entityNameSnapshot: 'Name',
    severityScore: 2,
    confidenceLevel: 'HIGH',
    validResponseCount: 10,
    dontKnowRate: 0.2,
    methodologyVersionId: 'mv1',
    ...over,
  });

  beforeEach(() => undefined);

  it('summarises the rollups at every level, defaulting the version', async () => {
    const { svc, tx } = setup();
    tx.scoreRollup.findFirst.mockResolvedValue(rollup());
    tx.scoreRollup.findMany.mockResolvedValue([rollup(), rollup({ severityScore: null })]);
    tx.survey.findUnique.mockResolvedValueOnce({ methodologyVersion: null });
    const dashboard = await svc.getDashboard('s1', 'sv1', 'v1');
    expect(dashboard.overall).toMatchObject({ severityScore: 2, dontKnowRate: 0.2 });
    expect(dashboard.domains[1]!.severityScore).toBeNull();
    expect(dashboard.methodologyVersion).toBe('v5.0');
    tx.scoreRollup.findFirst.mockResolvedValue(null);
    tx.survey.findUnique.mockResolvedValueOnce(null);
    expect((await svc.getDashboard('s1', 'sv1', null)).overall).toBeNull();
  });

  it('ranks KPIs and attaches their indicator, sub-domain and domain', async () => {
    const { svc, tx } = setup();
    tx.scoreRollup.findMany.mockResolvedValue([
      rollup({ entityId: 'K1' }),
      rollup({ entityId: 'K2', severityScore: null }),
    ]);
    tx.question.findMany.mockResolvedValue([
      { kpi: 'K1', indicator: 'I', subDomain: 'S', domain: 'D' },
      { kpi: 'K1', indicator: 'dup', subDomain: 'x', domain: 'y' },
      { kpi: null, indicator: 'n', subDomain: 'n', domain: 'n' },
    ]);
    const ranking = await svc.getKpiRanking('s1', 'sv1', 'v1');
    expect(ranking[0]).toMatchObject({ rank: 1, kpi: 'K1', indicator: 'I', domain: 'D' });
    expect(ranking[1]).toMatchObject({ rank: 2, indicator: '', severityScore: null });
    tx.scoreRollup.findMany.mockResolvedValue([]);
    expect(await svc.getKpiRanking('s1', 'sv1', null)).toEqual([]);
  });

  describe('getQuestionDetail', () => {
    const question = (over: Record<string, unknown> = {}) => ({
      questionId: 'Q1',
      questionText: 'T',
      isScoreable: true,
      domain: 'D',
      subDomain: 'S',
      kpi: 'K',
      indicator: 'I',
      answerOptions: ['Option A', 'Option B'],
      ...over,
    });

    it('builds the distribution from stored answers across answer shapes', async () => {
      const { svc, tx } = setup();
      tx.question.findFirst.mockResolvedValue(question());
      tx.scoreRollup.findUnique.mockResolvedValue({
        severityScore: 3,
        validResponseCount: 5,
        excludedResponseCount: 1,
        dontKnowCount: 2,
        notApplicableCount: 0,
        calculatedAt: new Date('2026-03-01T00:00:00Z'),
      });
      tx.responseAnswer.findMany.mockResolvedValue([
        {
          answerOptionId: 'OPTION_A',
          answerOptionIds: null,
          answerNumericValue: null,
          answerText: null,
        },
        {
          answerOptionId: null,
          answerOptionIds: ['OPTION_A', 'OPTION_B'],
          answerNumericValue: null,
          answerText: null,
        },
        { answerOptionId: null, answerOptionIds: null, answerNumericValue: 7, answerText: null },
        {
          answerOptionId: null,
          answerOptionIds: null,
          answerNumericValue: null,
          answerText: 'free',
        },
        { answerOptionId: null, answerOptionIds: null, answerNumericValue: null, answerText: null },
      ]);
      tx.scoringLookup.findMany.mockResolvedValue([
        {
          optionId: 'OPTION_A',
          lookupType: 'SCORE',
          severityScore: 4,
          isExcluded: false,
          exclusionReason: null,
        },
        {
          optionId: null,
          lookupType: 'N',
          severityScore: null,
          isExcluded: true,
          exclusionReason: 'x',
        },
      ]);
      const detail = await svc.getQuestionDetail('s1', 'sv1', 'Q1', 'v1');
      expect(detail.optionsDistribution).toEqual([
        { optionId: 'OPTION_A', label: 'Option A', count: 2 },
        { optionId: 'OPTION_B', label: 'Option B', count: 1 },
      ]);
      expect(detail).toMatchObject({
        averageSeverity: 3,
        validCount: 5,
        excludedCount: 1,
        methodologyVersion: 'v5.0',
        calculatedAt: '2026-03-01T00:00:00.000Z',
      });
      expect(detail.lookups[1]).toMatchObject({ severityScore: null, isExcluded: true });
    });

    it('uses observed values when the question has no fixed options, and defaults with no rollup', async () => {
      const { svc, tx } = setup();
      tx.question.findFirst.mockResolvedValue(question({ answerOptions: null }));
      tx.responseAnswer.findMany.mockResolvedValue([
        { answerOptionId: null, answerOptionIds: null, answerNumericValue: 3, answerText: null },
      ]);
      const detail = await svc.getQuestionDetail('s1', 'sv1', 'Q1', null);
      expect(detail.optionsDistribution).toEqual([{ optionId: '3', label: '3', count: 1 }]);
      expect(detail).toMatchObject({ averageSeverity: null, validCount: 0, dontKnowCount: 0 });
    });

    it('finds a question by KPI when the id is not a question id, and 404s otherwise', async () => {
      const { svc, tx } = setup();
      tx.question.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(question());
      await svc.getQuestionDetail('s1', 'sv1', 'K', 'v1');
      tx.question.findFirst.mockResolvedValue(null);
      await expect(svc.getQuestionDetail('s1', 'sv1', 'nope', null)).rejects.toMatchObject({
        response: { error: { code: 'QUESTION_NOT_FOUND' } },
      });
      tx.methodologyVersion.findFirst.mockResolvedValue(null);
      tx.survey.findUnique.mockResolvedValue(null);
      await expect(svc.getQuestionDetail('s1', 'sv1', 'Q1', null)).rejects.toMatchObject({
        response: { error: { code: 'METHODOLOGY_VERSION_NOT_FOUND' } },
      });
    });
  });
});
