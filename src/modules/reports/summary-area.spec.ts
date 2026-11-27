import { describe, expect, it } from 'vitest';
import { computeRollups, type RollupQuestionDef, type RollupScoreInput } from '../priority/rollup-compute';
import {
  areaFilterOf,
  areaPriorityAssessment,
  dedupeResponseScores,
  responseAreaWhere,
  toScoreRollups,
  topKpiRollups,
} from './summary-area';

const SETTINGS = { minRespondentsForStandardConfidence: 2, dontKnowRatioThreshold: 0.2 };
const IDS = { orgId: 'o', studyId: 's', surveyId: 'v', methodologyVersionId: 'm' };

const QUESTIONS: RollupQuestionDef[] = [
  { questionId: 'Q1', questionText: 'Q one', kpi: 'K1', indicator: 'I1', subDomain: 'S1', domain: 'Health' },
  { questionId: 'Q2', questionText: 'Q two', kpi: 'K1', indicator: 'I1', subDomain: 'S1', domain: 'Health' },
  { questionId: 'Q3', questionText: 'Q three', kpi: 'K2', indicator: 'I2', subDomain: 'S2', domain: 'Water' },
];
const score = (questionId: string, severityScore: number | null, extra: Partial<RollupScoreInput> = {}) => ({
  questionId,
  scoreStatus: severityScore === null ? 'EXCLUDED' : 'SCORED',
  severityScore,
  exclusionReason: null,
  ...extra,
});

describe('computeRollups (shared by stored and area rollups)', () => {
  it('averages each level from the one below, OVERALL last', () => {
    const rows = computeRollups(
      [score('Q1', 80), score('Q1', 60), score('Q2', 40), score('Q3', 20), score('Q3', 10)],
      QUESTIONS,
      null,
      SETTINGS,
    );
    const get = (level: string, id: string) => rows.find((r) => r.rollupLevel === level && r.entityId === id)!;
    expect(get('QUESTION', 'Q1').severityScore).toBe(70);
    expect(get('KPI', 'K1').severityScore).toBe(55); // (70 + 40) / 2
    expect(get('INDICATOR', 'I1').severityScore).toBe(55);
    expect(get('DOMAIN', 'Health').severityScore).toBe(55);
    expect(get('DOMAIN', 'Water').severityScore).toBe(15);
    expect(get('OVERALL', 'OVERALL').severityScore).toBe(35);
    expect(rows.at(-1)!.rollupLevel).toBe('OVERALL');
    expect(rows[0]!.rollupLevel).toBe('QUESTION');
  });

  it('marks LOW confidence below the respondent floor and on a high don\'t-know rate', () => {
    const rows = computeRollups(
      [score('Q1', 50), score('Q3', 50), score('Q3', 40), score('Q3', null, { exclusionReason: 'DONT_KNOW' })],
      QUESTIONS,
      null,
      SETTINGS,
    );
    expect(rows.find((r) => r.entityId === 'Q1')!.confidenceLevel).toBe('LOW'); // 1 < 2
    const q3 = rows.find((r) => r.entityId === 'Q3')!;
    expect(q3.dontKnowCount).toBe(1);
    expect(q3.confidenceLevel).toBe('LOW'); // 1/3 > 0.2
  });

  it('ignores scores for questions outside the methodology version', () => {
    const rows = computeRollups([score('OTHER', 90)], QUESTIONS, null, SETTINGS);
    expect(rows).toEqual([]);
  });
});

describe('summary area filter (UAT PRI-07)', () => {
  it('applies to VILLAGE scope only, centre over governorate, village over both', () => {
    expect(areaFilterOf('VILLAGE', { governorateId: 'g' })).toEqual({ kind: 'GOVERNORATE', id: 'g' });
    expect(areaFilterOf('VILLAGE', { governorateId: 'g', centerId: 'c' })).toEqual({ kind: 'CENTER', id: 'c' });
    expect(areaFilterOf('VILLAGE', { villageId: 'v', governorateId: 'g' })).toBeNull();
    expect(areaFilterOf('SECTOR', { governorateId: 'g' })).toBeNull();
    expect(areaFilterOf('VILLAGE', { governorateId: '  ' })).toBeNull();
  });

  it('selects respondents by where they said they live', () => {
    expect(responseAreaWhere({ kind: 'GOVERNORATE', id: 'g' })).toEqual({ governorateIds: { has: 'g' } });
    expect(responseAreaWhere({ kind: 'CENTER', id: 'c' })).toEqual({ centerIds: { has: 'c' } });
  });

  it('counts a respondent once even when scoring copied them per need village', () => {
    const scores = [
      { ...score('Q1', 80), surveyResponseId: 'r1' },
      { ...score('Q1', 80), surveyResponseId: 'r1' },
      { ...score('Q1', 20), surveyResponseId: 'r2' },
    ];
    expect(dedupeResponseScores(scores)).toHaveLength(2);
  });

  it('orders Top KPIs by severity, unscored last, within the sector', () => {
    const rows = toScoreRollups(
      [
        { rollupLevel: 'KPI', entityId: 'A', entityNameSnapshot: 'A', severityScore: null, validResponseCount: 0, excludedResponseCount: 0, dontKnowCount: 0, dontKnowRate: 0, notApplicableCount: 0, confidenceLevel: 'LOW' },
        { rollupLevel: 'KPI', entityId: 'B', entityNameSnapshot: 'B', severityScore: 30, validResponseCount: 3, excludedResponseCount: 0, dontKnowCount: 0, dontKnowRate: 0, notApplicableCount: 0, confidenceLevel: 'STANDARD' },
        { rollupLevel: 'KPI', entityId: 'C', entityNameSnapshot: 'C', severityScore: 70, validResponseCount: 3, excludedResponseCount: 0, dontKnowCount: 0, dontKnowRate: 0, notApplicableCount: 0, confidenceLevel: 'STANDARD' },
      ],
      IDS,
    );
    expect(topKpiRollups(rows, null).map((r) => r.entityId)).toEqual(['C', 'B', 'A']);
    expect(topKpiRollups(rows, new Set(['A', 'B'])).map((r) => r.entityId)).toEqual(['B', 'A']);
    expect(rows[1]!.severityScore!.toString()).toBe('30');
  });

  it('builds the area priority like a village, or none without config', () => {
    const domains = toScoreRollups(
      computeRollups([score('Q1', 80), score('Q1', 80), score('Q3', 20), score('Q3', 20)], QUESTIONS, null, SETTINGS),
      IDS,
    ).filter((r) => r.rollupLevel === 'DOMAIN');
    expect(areaPriorityAssessment([], domains, IDS)).toBeNull();
    const pa = areaPriorityAssessment(
      [
        { domainKey: 'HEALTH', domainNameSnapshot: 'Health', weight: 0.5, isCriticalDomain: false, criticalPerformanceThreshold: 30 },
        { domainKey: 'WATER', domainNameSnapshot: 'Water', weight: 0.5, isCriticalDomain: false, criticalPerformanceThreshold: 30 },
      ],
      domains,
      IDS,
    );
    expect(pa).not.toBeNull();
    expect(Array.isArray(pa!.domainComponents)).toBe(true);
    expect((pa!.domainComponents as unknown[]).length).toBe(2);
  });
});
