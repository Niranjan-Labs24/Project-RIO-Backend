import { describe, it, expect } from 'vitest';
import {
  computePriority,
  resolveStrategicAxis,
  scaleToPercent,
  type FactorInputs,
} from './priority-factors';
import { DEFAULT_PRIORITY_FACTOR_SCALES } from '../methodology-config/methodology-config.service';
import type { PriorityFactorWeight } from '../methodology-config/methodology-config.types';

const SCALES = DEFAULT_PRIORITY_FACTOR_SCALES;

/** The seeded nine, in the methodology's own order and weights. */
const WEIGHTS: PriorityFactorWeight[] = [
  { key: 'severity', label: 'Need severity', weight: 0.2 },
  { key: 'affected_population', label: 'Affected population', weight: 0.15 },
  { key: 'service_availability_gap', label: 'Service availability gap', weight: 0.12 },
  { key: 'urgency', label: 'Urgency', weight: 0.12 },
  { key: 'data_confidence', label: 'Data confidence', weight: 0.1 },
  { key: 'frequency', label: 'Frequency of similar needs', weight: 0.1 },
  { key: 'geographic_coverage', label: 'Geographic coverage', weight: 0.08 },
  { key: 'vulnerable_groups', label: 'Vulnerable groups (equity)', weight: 0.08 },
  { key: 'strategic_alignment', label: 'Strategic alignment', weight: 0.05 },
];

function inputs(overrides: Partial<FactorInputs> = {}): FactorInputs {
  return {
    severity: null,
    serviceGapSeverity: null,
    affectedPeople: null,
    urgency: null,
    dontKnowRate: null,
    themeMatchCount: null,
    villageCount: null,
    equitySpread: null,
    domain: null,
    questionIds: [],
    ...overrides,
  };
}

const by = (r: ReturnType<typeof computePriority>, key: string) =>
  r.components.find((c) => c.key === key)!;

describe('scaleToPercent', () => {
  it('maps floor to 0 and ceiling to 100', () => {
    expect(scaleToPercent(0, { floor: 0, ceiling: 1000 })).toBe(0);
    expect(scaleToPercent(1000, { floor: 0, ceiling: 1000 })).toBe(100);
  });

  it('is linear in between', () => {
    expect(scaleToPercent(450, { floor: 0, ceiling: 1000 })).toBe(45);
  });

  it('clamps rather than exceeding 100 — 5,000 people is not 500%', () => {
    expect(scaleToPercent(5000, { floor: 0, ceiling: 1000 })).toBe(100);
    expect(scaleToPercent(-20, { floor: 0, ceiling: 1000 })).toBe(0);
  });

  it('honours a non-zero floor', () => {
    // Geographic coverage starts at one village: a single-village need is the
    // baseline, not an outlier.
    expect(scaleToPercent(1, { floor: 1, ceiling: 10 })).toBe(0);
    expect(scaleToPercent(10, { floor: 1, ceiling: 10 })).toBe(100);
  });

  it('returns 0 for an inverted range rather than a negative or NaN value', () => {
    expect(scaleToPercent(5, { floor: 10, ceiling: 10 })).toBe(0);
  });
});

describe('resolveStrategicAxis', () => {
  it('matches on the domain by default', () => {
    const axis = resolveStrategicAxis(SCALES.strategicAxes, 'Health', []);
    expect(axis?.key).toBe('essential_services');
  });

  it('covers all nine domains, so no need falls through to null', () => {
    const domains = [
      'Health', 'Education', 'Water & Sanitation', 'Energy & Environment',
      'Livelihood', 'Infrastructure', 'Social Development', 'Culture',
      'Governance & Services',
    ];
    for (const d of domains) {
      expect(resolveStrategicAxis(SCALES.strategicAxes, d, []), d).not.toBeNull();
    }
  });

  it('an individually tagged question beats its domain', () => {
    // INF-10 sits in Infrastructure but the workbook tags it to the economy
    // axis — safeguard 4's cross-cutting case.
    const axis = resolveStrategicAxis(SCALES.strategicAxes, 'Infrastructure', ['INF-10']);
    expect(axis?.key).toBe('diversified_economy');
  });

  it('untagged questions in the same domain still take the domain axis', () => {
    const axis = resolveStrategicAxis(SCALES.strategicAxes, 'Infrastructure', ['INF-02']);
    expect(axis?.key).toBe('essential_services');
  });

  it('preserves the workbook ordering — empowerment above economy above capability above essential', () => {
    const value = (k: string) => SCALES.strategicAxes.find((a) => a.key === k)!.value;
    expect(value('non_profit_empowerment')).toBeGreaterThan(value('diversified_economy'));
    expect(value('diversified_economy')).toBeGreaterThan(value('human_capability'));
    expect(value('human_capability')).toBeGreaterThan(value('essential_services'));
  });

  it('returns null when there is no domain and no tagged question', () => {
    expect(resolveStrategicAxis(SCALES.strategicAxes, null, [])).toBeNull();
  });
});

describe('computePriority — AC 2, every component individually visible', () => {
  it('returns one component per configured weight, even the unmeasured ones', () => {
    const r = computePriority(WEIGHTS, SCALES, inputs({ severity: 78 }));
    expect(r.components).toHaveLength(9);
    expect(r.components.map((c) => c.key)).toContain('urgency');
  });

  it('carries weight, value, contribution and a plain-language basis', () => {
    const r = computePriority(WEIGHTS, SCALES, inputs({ affectedPeople: 450 }));
    const c = by(r, 'affected_population');
    expect(c.weight).toBe(0.15);
    expect(c.value).toBe(45);
    expect(c.contribution).toBeCloseTo(6.75, 5);
    expect(c.basis).toBe('450 people affected');
  });
});

describe('computePriority — missing evidence is null, never zero', () => {
  it('an unset urgency reports null, not 0', () => {
    const r = computePriority(WEIGHTS, SCALES, inputs({ severity: 78 }));
    const u = by(r, 'urgency');
    expect(u.value).toBeNull();
    expect(u.contribution).toBeNull();
    expect(u.basis).toBeNull();
  });

  it('an unmeasured factor does not drag the score down', () => {
    // Severity 78 alone must score 78 — not 78 × 0.20 = 15.6, which is what
    // dividing by the full weight would produce.
    const r = computePriority(WEIGHTS, SCALES, inputs({ severity: 78 }));
    expect(r.score).toBe(78);
  });

  it('reports coverage so a partial score is never mistaken for a complete one', () => {
    const r = computePriority(WEIGHTS, SCALES, inputs({ severity: 78 }));
    expect(r.coverage).toBeCloseTo(0.2, 5);
  });

  it('an urgency level missing from the config map is unmeasured, not "not urgent"', () => {
    const r = computePriority(WEIGHTS, SCALES, inputs({ urgency: 'whenever' }));
    expect(by(r, 'urgency').value).toBeNull();
  });

  it('scores 0 with coverage 0 when nothing at all is known', () => {
    const r = computePriority(WEIGHTS, SCALES, inputs());
    expect(r.score).toBe(0);
    expect(r.coverage).toBe(0);
  });
});

describe('computePriority — the weighted mean', () => {
  it('two measured factors combine in proportion to their weights', () => {
    // severity 80 (w .20) + urgency immediate=100 (w .12)
    // = (80×.20 + 100×.12) / .32 = 87.5
    const r = computePriority(
      WEIGHTS,
      SCALES,
      inputs({ severity: 80, urgency: 'immediate' }),
    );
    expect(r.score).toBe(87.5);
    expect(r.coverage).toBeCloseTo(0.32, 5);
  });

  it('a fully measured need normalises over the whole weight', () => {
    const r = computePriority(
      WEIGHTS,
      SCALES,
      inputs({
        severity: 100, serviceGapSeverity: 100, affectedPeople: 1000,
        urgency: 'immediate', dontKnowRate: 1, themeMatchCount: 20,
        villageCount: 10, equitySpread: 100, domain: 'Governance & Services',
      }),
    );
    expect(r.score).toBe(100);
    expect(r.coverage).toBe(1);
  });

  it('keeps the methodology severity polarity — higher is more urgent (AC 7)', () => {
    const worse = computePriority(WEIGHTS, SCALES, inputs({ severity: 90 }));
    const better = computePriority(WEIGHTS, SCALES, inputs({ severity: 20 }));
    expect(worse.score).toBeGreaterThan(better.score);
  });

  it('urgency separates two needs with identical severity', () => {
    // The ticket's own reason for having an urgency factor at all.
    const roof = computePriority(
      WEIGHTS, SCALES,
      inputs({ severity: 78, urgency: 'next_cycle' }),
    );
    const water = computePriority(
      WEIGHTS, SCALES,
      inputs({ severity: 78, urgency: 'immediate' }),
    );
    expect(water.score).toBeGreaterThan(roof.score);
  });

  it('recurrence separates two needs with identical severity', () => {
    const isolated = computePriority(
      WEIGHTS, SCALES, inputs({ severity: 78, themeMatchCount: 0 }),
    );
    const widespread = computePriority(
      WEIGHTS, SCALES, inputs({ severity: 78, themeMatchCount: 22 }),
    );
    expect(widespread.score).toBeGreaterThan(isolated.score);
    expect(by(widespread, 'frequency').basis).toBe('22 other need(s) share its themes');
  });

  it('data confidence scores the DOUBT, not the certainty', () => {
    // A need whose evidence is mostly "don't know" needs looking at; one with
    // clean data does not get a priority boost for being well measured.
    const shaky = computePriority(WEIGHTS, SCALES, inputs({ dontKnowRate: 0.9 }));
    const solid = computePriority(WEIGHTS, SCALES, inputs({ dontKnowRate: 0.0 }));
    expect(shaky.score).toBeGreaterThan(solid.score);
  });

  it('honours edited weights rather than any built-in number', () => {
    // The whole point of the config split: doubling severity's weight must
    // change the result with no code change.
    const reweighted = WEIGHTS.map((w) =>
      w.key === 'severity' ? { ...w, weight: 0.9 } : w,
    );
    const base = computePriority(WEIGHTS, SCALES, inputs({ severity: 90, urgency: 'no_fixed_timeline' }));
    const heavy = computePriority(reweighted, SCALES, inputs({ severity: 90, urgency: 'no_fixed_timeline' }));
    expect(heavy.score).toBeGreaterThan(base.score);
  });

  it('honours edited scales rather than any built-in range', () => {
    const tight = { ...SCALES, affectedPopulation: { floor: 0, ceiling: 100 } };
    const base = computePriority(WEIGHTS, SCALES, inputs({ affectedPeople: 100 }));
    const scaled = computePriority(WEIGHTS, tight, inputs({ affectedPeople: 100 }));
    expect(base.score).toBe(10);
    expect(scaled.score).toBe(100);
  });
});
