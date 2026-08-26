import { describe, expect, it } from 'vitest';
import { computeQuestionWeights, type WeightableQuestion } from './question-weight.util';

describe('computeQuestionWeights', () => {
  it('matches the client-confirmed example exactly (Q32, 2026-08-20)', () => {
    // Domain: Health (100%)
    //   Sub-domain: Maternal Health (50% -- 1 of 2 sub-domains under Health)
    //     Indicator: Antenatal Coverage (25% -- 1 of 2 indicators)
    //       KPI: ANC 4+ Visits (12.5% -- 1 of 2 KPIs)
    //         Q1, Q2 (2 questions) -> each 6.25%
    const questions: WeightableQuestion[] = [
      { id: 'q1', domain: 'Health', subDomain: 'Maternal Health', indicator: 'Antenatal Coverage', kpi: 'ANC 4+ Visits' },
      { id: 'q2', domain: 'Health', subDomain: 'Maternal Health', indicator: 'Antenatal Coverage', kpi: 'ANC 4+ Visits' },
      // The other KPI under Antenatal Coverage, so kpiCount = 2.
      { id: 'q3', domain: 'Health', subDomain: 'Maternal Health', indicator: 'Antenatal Coverage', kpi: 'Iron Supplementation' },
      // The other indicator under Maternal Health, so indicatorCount = 2.
      { id: 'q4', domain: 'Health', subDomain: 'Maternal Health', indicator: 'Skilled Birth Attendance', kpi: 'SBA Rate' },
      // The other sub-domain under Health, so subDomainCount = 2.
      { id: 'q5', domain: 'Health', subDomain: 'Child Health', indicator: 'Immunization', kpi: 'Full Immunization' },
    ];

    const weights = computeQuestionWeights(questions);

    // subDomainCount(Health)=2, indicatorCount(Maternal Health)=2,
    // kpiCount(Antenatal Coverage)=2, questionCount(ANC 4+ Visits)=2
    // => 1 / (2*2*2*2) = 1/16 = 0.0625 = 6.25%, matching the client's example.
    expect(weights.get('q1')).toBeCloseTo(0.0625, 10);
    expect(weights.get('q2')).toBeCloseTo(0.0625, 10);
    expect(weights.get('q1')).toBe(weights.get('q2'));
  });

  it('gives a lone question under its KPI the full weight of that KPI slot', () => {
    const questions: WeightableQuestion[] = [
      { id: 'q1', domain: 'WASH', subDomain: 'Water', indicator: 'Access', kpi: 'Source Reliability' },
    ];
    const weights = computeQuestionWeights(questions);
    // Only domain/subDomain/indicator/KPI/question in the set -> 1/(1*1*1*1) = 1.0.
    expect(weights.get('q1')).toBe(1);
  });

  it('splits evenly across sibling questions under the same KPI', () => {
    const questions: WeightableQuestion[] = [
      { id: 'a', domain: 'D', subDomain: 'S', indicator: 'I', kpi: 'K' },
      { id: 'b', domain: 'D', subDomain: 'S', indicator: 'I', kpi: 'K' },
      { id: 'c', domain: 'D', subDomain: 'S', indicator: 'I', kpi: 'K' },
    ];
    const weights = computeQuestionWeights(questions);
    expect(weights.get('a')).toBeCloseTo(1 / 3, 10);
    expect(weights.get('b')).toBeCloseTo(1 / 3, 10);
    expect(weights.get('c')).toBeCloseTo(1 / 3, 10);
  });

  it('scopes weight per-domain, not globally across all domains', () => {
    const questions: WeightableQuestion[] = [
      { id: 'q1', domain: 'Health', subDomain: 'S', indicator: 'I', kpi: 'K' },
      { id: 'q2', domain: 'Education', subDomain: 'S', indicator: 'I', kpi: 'K' },
    ];
    const weights = computeQuestionWeights(questions);
    // Each is the only question in its own domain's tree -> both get 1.0,
    // not 0.5 each — domain-vs-domain importance is a separate mechanism.
    expect(weights.get('q1')).toBe(1);
    expect(weights.get('q2')).toBe(1);
  });

  it('groups a null indicator/kpi under a stable fallback bucket instead of throwing', () => {
    const questions: WeightableQuestion[] = [
      { id: 'q1', domain: 'D', subDomain: 'S', indicator: null, kpi: null },
      { id: 'q2', domain: 'D', subDomain: 'S', indicator: null, kpi: null },
    ];
    const weights = computeQuestionWeights(questions);
    expect(weights.get('q1')).toBeCloseTo(0.5, 10);
    expect(weights.get('q2')).toBeCloseTo(0.5, 10);
  });

  it('does not corrupt grouping when domain/sub-domain text contains spaces', () => {
    const questions: WeightableQuestion[] = [
      { id: 'q1', domain: 'Water Sanitation', subDomain: 'Household Access', indicator: 'I', kpi: 'K' },
      { id: 'q2', domain: 'Water', subDomain: 'Sanitation Household Access', indicator: 'I', kpi: 'K' },
    ];
    const weights = computeQuestionWeights(questions);
    // Two genuinely distinct (domain, subDomain) pairs that happen to
    // concatenate to the same characters — must not collide into one bucket.
    expect(weights.get('q1')).toBe(1);
    expect(weights.get('q2')).toBe(1);
  });
});
