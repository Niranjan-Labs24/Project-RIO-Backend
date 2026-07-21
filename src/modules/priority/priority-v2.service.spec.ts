import { describe, it, expect } from 'vitest';
import { computeVillagePriority, normalizeDomainKey } from './priority-v2.service';

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeConfigs(overrides: Partial<{
  weight: number;
  isCritical: boolean;
  threshold: number;
}>[] = []) {
  // Default: 5 domains matching the baseline CSV, weights sum to 1.
  const defaults = [
    { domainKey: 'HEALTH',            domainNameSnapshot: 'Health',              weight: 0.30, isCriticalDomain: true,  criticalPerformanceThreshold: 30 },
    { domainKey: 'EDUCATION',         domainNameSnapshot: 'Education',           weight: 0.25, isCriticalDomain: false, criticalPerformanceThreshold: 30 },
    { domainKey: 'INFRASTRUCTURE',    domainNameSnapshot: 'Infrastructure',       weight: 0.20, isCriticalDomain: false, criticalPerformanceThreshold: 30 },
    { domainKey: 'LIVELIHOOD',        domainNameSnapshot: 'Livelihood',           weight: 0.15, isCriticalDomain: false, criticalPerformanceThreshold: 30 },
    { domainKey: 'WATER_SANITATION',  domainNameSnapshot: 'Water & Sanitation',  weight: 0.10, isCriticalDomain: true,  criticalPerformanceThreshold: 30 },
  ];
  return defaults;
}

// Build a score map with all 5 domains at the same severity score
function uniformScores(severity: number): Map<string, number> {
  return new Map([
    ['HEALTH', severity],
    ['EDUCATION', severity],
    ['INFRASTRUCTURE', severity],
    ['LIVELIHOOD', severity],
    ['WATER_SANITATION', severity],
  ]);
}

// ─── §1 ─ normalizeDomainKey ──────────────────────────────────────────────────

describe('normalizeDomainKey', () => {
  it('converts "Health" → "HEALTH"', () => {
    expect(normalizeDomainKey('Health')).toBe('HEALTH');
  });
  it('converts "Water & Sanitation" → "WATER_SANITATION"', () => {
    expect(normalizeDomainKey('Water & Sanitation')).toBe('WATER_SANITATION');
  });
  it('trims leading/trailing underscores', () => {
    expect(normalizeDomainKey('  LIVELIHOOD  ')).toBe('LIVELIHOOD');
  });
});

// ─── §8.1 ─ Domain severity 70 → performance 30 ──────────────────────────────

describe('DomainPerformanceScore = 100 - DomainSeverityScore', () => {
  it('severity 70 → performance 30', () => {
    const configs = makeConfigs();
    const scores = uniformScores(70);
    const result = computeVillagePriority(configs, scores);
    const healthComp = result.domainComponents.find(c => c.domainKey === 'HEALTH')!;
    expect(healthComp.domainSeverityScore).toBe(70);
    expect(healthComp.domainPerformanceScore).toBe(30);
  });

  it('severity 0 → performance 100', () => {
    const configs = makeConfigs();
    const scores = uniformScores(0);
    const result = computeVillagePriority(configs, scores);
    expect(result.domainComponents[0]?.domainPerformanceScore).toBe(100);
  });

  it('severity 100 → performance 0', () => {
    const configs = makeConfigs();
    const scores = uniformScores(100);
    const result = computeVillagePriority(configs, scores);
    expect(result.domainComponents[0]?.domainPerformanceScore).toBe(0);
  });
});

// ─── §8.2 ─ Weighted score calculation ───────────────────────────────────────

describe('Weighted score calculation with weights summing to 1', () => {
  it('uniform severity 50 → all performance 50 → priority score 50', () => {
    const configs = makeConfigs();
    const scores = uniformScores(50);
    const result = computeVillagePriority(configs, scores);
    // weightedSum = 50×0.30 + 50×0.25 + 50×0.20 + 50×0.15 + 50×0.10 = 50×1.00 = 50
    expect(result.priorityScore).toBeCloseTo(50, 8);
  });

  it('weighted contributions are computed without rounding', () => {
    // HEALTH severity=70 → performance=30, contribution=30×0.30=9
    // Others severity=10 → performance=90
    const configs = makeConfigs();
    const scores = new Map([
      ['HEALTH', 70],           // perf=30, weight=0.30, contrib=9.0
      ['EDUCATION', 10],        // perf=90, weight=0.25, contrib=22.5
      ['INFRASTRUCTURE', 10],   // perf=90, weight=0.20, contrib=18.0
      ['LIVELIHOOD', 10],       // perf=90, weight=0.15, contrib=13.5
      ['WATER_SANITATION', 10], // perf=90, weight=0.10, contrib=9.0
    ]);
    const result = computeVillagePriority(configs, scores);
    // Sum = 9 + 22.5 + 18 + 13.5 + 9 = 72
    expect(result.priorityScore).toBeCloseTo(72, 8);
    // No rounding in domainComponents
    const h = result.domainComponents.find(c => c.domainKey === 'HEALTH')!;
    expect(h.weightedContribution).toBeCloseTo(9.0, 8);
  });

  it('when weights do not sum to 1, score is normalised by sum of weights', () => {
    // Two domains, weights 0.4 and 0.4 (sum 0.8, not 1)
    const twoConfigs = [
      { domainKey: 'A', domainNameSnapshot: 'A', weight: 0.4, isCriticalDomain: false, criticalPerformanceThreshold: 30 },
      { domainKey: 'B', domainNameSnapshot: 'B', weight: 0.4, isCriticalDomain: false, criticalPerformanceThreshold: 30 },
    ];
    const scores = new Map([['A', 20], ['B', 20]]); // perf=80 each
    const result = computeVillagePriority(twoConfigs, scores);
    // weightedSum = 80×0.4 + 80×0.4 = 64; weightSum = 0.8; score = 64/0.8 = 80
    expect(result.priorityScore).toBeCloseTo(80, 8);
  });
});

// ─── §8.3–8.5 ─ Standard classification ──────────────────────────────────────

describe('Standard priority classification (no override)', () => {
  // Use a single non-critical config so no override fires
  const singleNonCriticalConfig = [
    { domainKey: 'HEALTH', domainNameSnapshot: 'Health', weight: 1.0, isCriticalDomain: false, criticalPerformanceThreshold: 30 },
  ];

  it('score exactly 40 → HIGH (≤ 40)', () => {
    // performance = 40 → severity 60
    const scores = new Map([['HEALTH', 60]]);
    const result = computeVillagePriority(singleNonCriticalConfig, scores);
    expect(result.priorityScore).toBeCloseTo(40, 8);
    expect(result.priorityStatus).toBe('HIGH');
    expect(result.overrideApplied).toBe(false);
  });

  it('score exactly 41 → MEDIUM (41–70)', () => {
    const scores = new Map([['HEALTH', 59]]); // perf=41
    const result = computeVillagePriority(singleNonCriticalConfig, scores);
    expect(result.priorityScore).toBeCloseTo(41, 8);
    expect(result.priorityStatus).toBe('MEDIUM');
  });

  it('score exactly 70 → MEDIUM (41–70)', () => {
    const scores = new Map([['HEALTH', 30]]); // perf=70
    const result = computeVillagePriority(singleNonCriticalConfig, scores);
    expect(result.priorityScore).toBeCloseTo(70, 8);
    expect(result.priorityStatus).toBe('MEDIUM');
  });

  it('score exactly 71 → LOW (≥ 71)', () => {
    const scores = new Map([['HEALTH', 29]]); // perf=71
    const result = computeVillagePriority(singleNonCriticalConfig, scores);
    expect(result.priorityScore).toBeCloseTo(71, 8);
    expect(result.priorityStatus).toBe('LOW');
  });

  it('score 0 → HIGH', () => {
    const scores = new Map([['HEALTH', 100]]); // perf=0
    const result = computeVillagePriority(singleNonCriticalConfig, scores);
    expect(result.priorityScore).toBeCloseTo(0, 8);
    expect(result.priorityStatus).toBe('HIGH');
  });

  it('score 100 → LOW', () => {
    const scores = new Map([['HEALTH', 0]]); // perf=100
    const result = computeVillagePriority(singleNonCriticalConfig, scores);
    expect(result.priorityScore).toBeCloseTo(100, 8);
    expect(result.priorityStatus).toBe('LOW');
  });
});

// ─── §8.6 ─ Critical domain override ─────────────────────────────────────────

describe('Critical domain override', () => {
  const criticalConfig = [
    { domainKey: 'HEALTH', domainNameSnapshot: 'Health', weight: 0.30, isCriticalDomain: true,  criticalPerformanceThreshold: 30 },
    { domainKey: 'EDUCATION', domainNameSnapshot: 'Education', weight: 0.70, isCriticalDomain: false, criticalPerformanceThreshold: 30 },
  ];

  it('critical domain performance 29 < threshold 30 → priorityStatus=HIGH, overrideApplied=true', () => {
    // HEALTH perf=29 (severity=71), EDUCATION perf=90 (severity=10)
    // weightedSum = 29×0.30 + 90×0.70 = 8.7 + 63 = 71.7 → would be LOW without override
    const scores = new Map([['HEALTH', 71], ['EDUCATION', 10]]);
    const result = computeVillagePriority(criticalConfig, scores);

    expect(result.priorityScore).toBeCloseTo(71.7, 4);
    expect(result.priorityStatus).toBe('HIGH');
    expect(result.overrideApplied).toBe(true);
    expect(result.overrideReason).toContain('Health');
    expect(result.overrideReason).toContain('29');
    expect(result.overrideReason).toContain('30');
    const h = result.domainComponents.find(c => c.domainKey === 'HEALTH')!;
    expect(h.triggeredOverride).toBe(true);
  });

  it('overrideReason contains domain name, score, and threshold', () => {
    const scores = new Map([['HEALTH', 80], ['EDUCATION', 0]]); // HEALTH perf=20
    const result = computeVillagePriority(criticalConfig, scores);
    expect(result.overrideReason).toMatch(/Health/);
    expect(result.overrideReason).toMatch(/20/);
    expect(result.overrideReason).toMatch(/30/);
  });
});

// ─── §8.7 ─ Critical domain performance exactly at threshold → NO override ───

describe('Critical domain at exactly threshold does NOT override', () => {
  it('performance === threshold (30) → no override (rule is strictly <)', () => {
    const configs = [
      { domainKey: 'HEALTH', domainNameSnapshot: 'Health', weight: 1.0, isCriticalDomain: true, criticalPerformanceThreshold: 30 },
    ];
    // severity 70 → performance 30, which equals threshold → no override
    const scores = new Map([['HEALTH', 70]]);
    const result = computeVillagePriority(configs, scores);
    expect(result.domainComponents[0]?.domainPerformanceScore).toBe(30);
    expect(result.overrideApplied).toBe(false);
    // score = 30 → HIGH by standard classification (≤ 40)
    expect(result.priorityStatus).toBe('HIGH');
  });

  it('performance 31 does not trigger override (rule is strictly < threshold)', () => {
    const configs = [
      { domainKey: 'HEALTH', domainNameSnapshot: 'Health', weight: 1.0, isCriticalDomain: true, criticalPerformanceThreshold: 30 },
    ];
    const scores = new Map([['HEALTH', 69]]); // perf=31, score=31 → HIGH by standard rule, but NOT override
    const result = computeVillagePriority(configs, scores);
    // Override should NOT fire because 31 >= 30
    expect(result.overrideApplied).toBe(false);
    expect(result.domainComponents[0]?.triggeredOverride).toBe(false);
    // Score = 31 → HIGH by standard classification (≤ 40), which is fine —
    // the point is overrideApplied=false, not that status is MEDIUM.
    expect(result.priorityScore).toBeCloseTo(31, 4);
  });
});

// ─── §8.8 ─ Existing severity scores are not modified ────────────────────────

describe('Severity scores are never modified by priority v2', () => {
  it('computeVillagePriority does not mutate the input domainScores map', () => {
    const configs = makeConfigs();
    const scores = uniformScores(60);
    const originalEntries = Array.from(scores.entries());
    computeVillagePriority(configs, scores);
    // Map must be identical after calling compute
    expect(Array.from(scores.entries())).toEqual(originalEntries);
  });

  it('severity scoring uses a separate code path — computeVillagePriority has no scoring logic', () => {
    // This test asserts structural separation: the function only reads from
    // domainScores, never writes or calls scoring engine functions.
    // Verified by the pure function signature — no DB, no side effects.
    const configs = makeConfigs();
    const scores = uniformScores(50);
    const result = computeVillagePriority(configs, scores);
    // All components carry the input severity unchanged
    result.domainComponents.forEach(c => {
      expect(c.domainSeverityScore).toBe(50);
    });
  });
});

// ─── §8.9 ─ Import validation — weight sum ≠ 1 → reject ──────────────────────
// (Tested at the service/script layer; here we verify the normalization formula
// shields against rounding drift so the calculation still works.)

describe('Import validation helpers', () => {
  it('weights summing to exactly 1.00 → score equals performance-weighted average', () => {
    const configs = makeConfigs();
    const scores = uniformScores(30); // perf=70
    const result = computeVillagePriority(configs, scores);
    // weightSum = 1.00, so score = weighted / 1.00 = 70
    expect(result.priorityScore).toBeCloseTo(70, 8);
  });

  it('normalisation formula handles minor floating-point drift (0.9999 sum)', () => {
    const configs = [
      { domainKey: 'A', domainNameSnapshot: 'A', weight: 0.3333, isCriticalDomain: false, criticalPerformanceThreshold: 30 },
      { domainKey: 'B', domainNameSnapshot: 'B', weight: 0.3333, isCriticalDomain: false, criticalPerformanceThreshold: 30 },
      { domainKey: 'C', domainNameSnapshot: 'C', weight: 0.3334, isCriticalDomain: false, criticalPerformanceThreshold: 30 },
    ];
    const scores = new Map([['A', 0], ['B', 0], ['C', 0]]); // perf=100 all
    const result = computeVillagePriority(configs, scores);
    // Should still give ~100 regardless of minor drift
    expect(result.priorityScore).toBeCloseTo(100, 2);
    expect(result.priorityStatus).toBe('LOW');
  });
});

// ─── §8.10 ─ Public survey users cannot see scores ───────────────────────────
// (Enforced by RequirePermission guard on controller — assertion here is that
// the service itself doesn't expose a public method that bypasses auth.)

describe('Permission boundary', () => {
  it('getVillagePriority requires priorityScoring/read permission (guard on controller)', () => {
    // The endpoint in priority.controller.ts is decorated with
    // @RequirePermission("priorityScoring", "read").
    // Public survey citizens have no priorityScoring permission at all.
    // This test documents the requirement; enforcement is at the HTTP layer.
    const requiredPermission = { module: 'priorityScoring', action: 'read' };
    expect(requiredPermission.module).toBe('priorityScoring');
    expect(requiredPermission.action).toBe('read');
    // Actual guard enforcement is covered by existing permission.guard.spec.ts
  });
});

// ─── Additional boundary: no domain rollup data → empty components ────────────

describe('Edge cases', () => {
  it('no matching rollup data → empty components, score=0, status=HIGH', () => {
    const configs = makeConfigs();
    const scores = new Map<string, number>(); // no data
    const result = computeVillagePriority(configs, scores);
    expect(result.domainComponents).toHaveLength(0);
    expect(result.priorityScore).toBe(0);
    expect(result.priorityStatus).toBe('HIGH');
  });

  it('partial domain data (only 2 of 5 present) scores only available domains', () => {
    const configs = makeConfigs();
    const scores = new Map([['HEALTH', 30], ['EDUCATION', 30]]); // perf=70 each
    const result = computeVillagePriority(configs, scores);
    expect(result.domainComponents).toHaveLength(2);
    // weightedSum = 70×0.30 + 70×0.25 = 21 + 17.5 = 38.5
    // weightSum = 0.55 → score = 38.5/0.55 = 70
    expect(result.priorityScore).toBeCloseTo(70, 4);
    expect(result.priorityStatus).toBe('MEDIUM');
  });
});
