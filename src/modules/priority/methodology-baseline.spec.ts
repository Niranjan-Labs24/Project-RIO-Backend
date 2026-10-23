/**
 * RIO-AI-005 (legacy FR-19) — approved methodology implementation baseline.
 *
 * Guards the v5.0 reference-data artifacts against the workbook they were
 * extracted from, and exercises the scoring engine against real severity values
 * taken from METH — Scoring Lookup rather than invented fixtures.
 *
 * Deliberately DB-free: these are assertions about the approved baseline itself,
 * so they must fail in CI on a bad extract without needing a seeded Postgres.
 * (The end-to-end proof — reproducing the workbook's own 3-village worked
 * example through the real rollup — needs a database and is tracked separately;
 * `verification-targets-v5.json` carries the expected outputs for it.)
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DeterministicScoringService } from './scoring.service';
import type { Question, ScoringLookup } from '../../generated/prisma';

const DIR = path.join(__dirname, '..', '..', '..', 'prisma', 'methodology');

interface BankQuestion {
  questionId: string;
  formerCode: string | null;
  domain: string;
  subDomain: string;
  indicator: string | null;
  kpi: string | null;
  measurementMode: string;
  answerTypeRaw: string;
  rosterScope: string | null;
  answerOptions: string[] | null;
  requiredOptional: string;
  isFielded: boolean;
  isScoreable: boolean;
  isHouseholdFielded: boolean;
  excludedFromNineDomainIndex: boolean;
  feedsKpiAnchor: string | null;
  conditionalRule: { dependsOn?: string | null; operator?: string; values?: string[] } | null;
}
interface Bank {
  _meta: { versionLabel: string; counts: Record<string, number> };
  hierarchy: Array<{ name: string; subDomains: string[] }>;
  questions: BankQuestion[];
}
interface Lookup {
  questionId: string;
  lookupType: string;
  optionId: string | null;
  optionLabel: string;
  severityScore: number | null;
  numericFloor: number | null;
  numericCeiling: number | null;
  severityDirection: string | null;
  isExcluded: boolean;
  exclusionReason: string | null;
  isComposite: boolean;
}

const bank: Bank = JSON.parse(fs.readFileSync(path.join(DIR, 'question-bank-v5.json'), 'utf-8'));
const lookupFile: { lookups: Lookup[] } = JSON.parse(
  fs.readFileSync(path.join(DIR, 'scoring-lookup-v5.json'), 'utf-8'),
);
const lookups = lookupFile.lookups;

/** Minimal Question stand-in — calculateSeverity only reads these fields. */
function q(questionId: string, overrides: Partial<Question> = {}): Question {
  const src = bank.questions.find((x) => x.questionId === questionId);
  if (!src) throw new Error(`${questionId} is not in the v5.0 bank`);
  return {
    questionId,
    measurementMode: src.measurementMode,
    isScoreable: src.isScoreable,
    conditionalRule: src.conditionalRule,
    ...overrides,
  } as unknown as Question;
}

/** ScoringLookup stand-ins for one question, as the service receives them. */
function lookupsFor(questionId: string): ScoringLookup[] {
  return lookups
    .filter((l) => l.questionId === questionId)
    .map((l, i) => ({ ...l, id: `${questionId}-${i}`, isActive: true })) as unknown as ScoringLookup[];
}

const svc = new DeterministicScoringService(null as never);

// ════════════════════════════════════════════════════════════════════════════
describe('v5.0 question bank matches the approved workbook (RIO-AI-005)', () => {
  // The workbook's own headline figures. See METH — Answer Type Defs' "Which
  // number to quote": these describe one bank at four scopes, not four totals.
  it.each([
    ['totalQuestions', 193],
    ['fieldItems', 186],
    ['severityScoredItems', 166],
    ['householdFieldedItems', 184],
    ['domains', 9],
    ['subDomains', 44],
    ['indicators', 172],
    ['feederItems', 20],
    ['diagnosticItems', 18],
  ])('%s = %i', (key, expected) => {
    expect(bank._meta.counts[key as string]).toBe(expected);
  });

  it('the counts are internally consistent, not just asserted', () => {
    expect(bank.questions).toHaveLength(193);
    expect(bank.questions.filter((x) => x.isFielded)).toHaveLength(186);
    expect(bank.questions.filter((x) => x.isScoreable)).toHaveLength(166);
    expect(bank.questions.filter((x) => x.isHouseholdFielded)).toHaveLength(184);
    expect(new Set(bank.questions.map((x) => x.questionId)).size).toBe(193);
  });

  it('covers the nine methodology domains and 44 sub-domains', () => {
    expect(bank.hierarchy.map((d) => d.name).sort()).toEqual([
      'Culture', 'Education', 'Energy & Environment', 'Governance & Services',
      'Health', 'Infrastructure', 'Livelihood', 'Social Development', 'Water & Sanitation',
    ]);
    expect(bank.hierarchy.reduce((n, d) => n + d.subDomains.length, 0)).toBe(44);
  });

  it('every question carries its v1.0 former code, so the code map is complete', () => {
    expect(bank.questions.filter((x) => !x.formerCode)).toEqual([]);
  });

  it('uses v5.0 question codes, not the v1.0 scheme', () => {
    for (const x of bank.questions) expect(x.questionId).toMatch(/^[A-Z]{3}-\d+$/);
    const prefixes = new Set(bank.questions.map((x) => x.questionId.slice(0, 3)));
    expect([...prefixes].sort()).toEqual([
      'CUL', 'EDU', 'ENV', 'GOV', 'HLT', 'INF', 'LIV', 'SOC', 'WSH', 'XDM',
    ]);
  });

  it('the 7 instrument-scaffolding modules are XDM-01..07 and are not fielded', () => {
    const notFielded = bank.questions.filter((x) => !x.isFielded).map((x) => x.questionId);
    expect(notFielded.sort()).toEqual([
      'XDM-01', 'XDM-02', 'XDM-03', 'XDM-04', 'XDM-05', 'XDM-06', 'XDM-07',
    ]);
  });

  it('WSH-15 is the administrative-record item and SOC-08 is protocol-gated', () => {
    // These two are exactly the difference between the 186 field items and the
    // 184 actually asked of a household.
    const notHousehold = bank.questions
      .filter((x) => x.isFielded && !x.isHouseholdFielded)
      .map((x) => x.questionId);
    expect(notHousehold.sort()).toEqual(['SOC-08', 'WSH-15']);
  });

  it('XDM-08 is scored but excluded from the nine-domain index', () => {
    const excluded = bank.questions.filter((x) => x.excludedFromNineDomainIndex);
    expect(excluded.map((x) => x.questionId)).toEqual(['XDM-08']);
    expect(excluded[0]!.isScoreable).toBe(true);
  });

  it('all 20 feeder items point at a real anchor question in the same bank', () => {
    const codes = new Set(bank.questions.map((x) => x.questionId));
    const feeders = bank.questions.filter((x) => x.feedsKpiAnchor);
    expect(feeders).toHaveLength(20);
    for (const f of feeders) expect(codes.has(f.feedsKpiAnchor!)).toBe(true);
  });

  it('reads the real Mandatory/Optional column instead of hardcoding "required"', () => {
    // The pre-v5.0 importer wrote requiredOptional = "required" for every row,
    // erasing the conditional and per-eligible-person distinctions entirely.
    const byKind = new Map<string, number>();
    for (const x of bank.questions) byKind.set(x.requiredOptional, (byKind.get(x.requiredOptional) ?? 0) + 1);
    expect(byKind.get('required')).toBe(146);
    expect(byKind.get('conditional')).toBe(28);
    expect(byKind.get('required_per_eligible_person')).toBe(15);
    expect(byKind.get('on_hold')).toBe(1);
    expect(byKind.get('not_fielded')).toBe(3);
  });

  it('records roster scope for every per-eligible-person question', () => {
    const rostered = bank.questions.filter((x) => x.rosterScope);
    expect(rostered.length).toBeGreaterThan(0);
    for (const x of rostered) expect(['person', 'child', 'woman', 'youth']).toContain(x.rosterScope);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('v5.0 scoring lookup', () => {
  it('covers every scoreable question', () => {
    const withLookup = new Set(lookups.map((l) => l.questionId));
    const missing = bank.questions
      .filter((x) => x.isScoreable && !withLookup.has(x.questionId))
      .map((x) => x.questionId);
    expect(missing).toEqual([]);
  });

  it('keeps every severity inside the 0-100 convention', () => {
    for (const l of lookups) {
      if (l.severityScore !== null) {
        expect(l.severityScore).toBeGreaterThanOrEqual(0);
        expect(l.severityScore).toBeLessThanOrEqual(100);
      }
    }
  });

  it('gives every numeric question both bounds and a resolved direction', () => {
    const numeric = lookups.filter((l) => l.lookupType === 'NUMERIC');
    expect(numeric).toHaveLength(16);
    for (const l of numeric) {
      expect(l.numericFloor).not.toBeNull();
      expect(l.numericCeiling).not.toBeNull();
      expect(l.numericCeiling).not.toBe(l.numericFloor);
      expect(['WORSENING_HIGHER', 'WORSENING_LOWER']).toContain(l.severityDirection);
    }
  });

  it('identifies exactly the four reversed numeric scales the workbook names', () => {
    // "v5.0 also includes reversed scales where a higher value is better
    // (antenatal visits, months of income, days of attendance)" — plus
    // growth-monitoring visits.
    const reversed = lookups
      .filter((l) => l.severityDirection === 'WORSENING_LOWER')
      .map((l) => l.questionId)
      .sort();
    expect(reversed).toEqual(['EDU-16', 'HLT-04', 'HLT-07', 'LIV-03']);
  });

  it('reads numeric bounds from the option label, not the severity column', () => {
    // The pre-v5.0 importer took the bound from the severity column. For HLT-04
    // (antenatal visits, reversed) that yields floor = 100 instead of 0, and for
    // INF-09 it flattens a real floor of 2 to 0.
    const hlt04 = lookups.find((l) => l.questionId === 'HLT-04' && l.lookupType === 'NUMERIC')!;
    expect(hlt04.numericFloor).toBe(0);
    expect(hlt04.numericCeiling).toBe(4);
    expect(hlt04.severityDirection).toBe('WORSENING_LOWER');

    const inf09 = lookups.find((l) => l.questionId === 'INF-09' && l.lookupType === 'NUMERIC')!;
    expect(inf09.numericFloor).toBe(2);
    expect(inf09.numericCeiling).toBe(4);
  });

  it('separates "Don\'t know" from applicability escapes', () => {
    // Only genuine "Don't know" feeds the >20% data-confidence indicator; an
    // eligibility escape leaves the denominator without implying ignorance.
    const reasons = new Set(lookups.filter((l) => l.isExcluded).map((l) => l.exclusionReason));
    expect([...reasons].sort()).toEqual(['DONT_KNOW', 'NOT_APPLICABLE', 'PREFER_NOT_TO_ANSWER']);
  });

  it('normalises composite option keys so selection order cannot matter', () => {
    for (const l of lookups.filter((x) => x.isComposite)) {
      const parts = l.optionId!.split('__');
      expect([...parts].sort()).toEqual(parts);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('scoring engine against real v5.0 severity values', () => {
  it('scores a binary single-select from the approved lookup (HLT-01)', () => {
    const ls = lookupsFor('HLT-01');
    expect(svc.calculateSeverity(q('HLT-01'), svc.parseRawAnswerValue('Yes', 'SINGLE_SELECT'), ls).score).toBe(0);
    expect(svc.calculateSeverity(q('HLT-01'), svc.parseRawAnswerValue('No', 'SINGLE_SELECT'), ls).score).toBe(100);
  });

  it("excludes Don't know from the denominator (HLT-01)", () => {
    const r = svc.calculateSeverity(
      q('HLT-01'),
      svc.parseRawAnswerValue("Don't know", 'SINGLE_SELECT'),
      lookupsFor('HLT-01'),
    );
    expect(r.status).toBe('EXCLUDED');
    expect(r.score).toBeNull();
    expect(r.exclusionReason).toBe('DONT_KNOW');
  });

  it('applies the four-point ordinal ramp 0/33/67/100 (HLT-03)', () => {
    const ls = lookupsFor('HLT-03');
    const at = (label: string) =>
      svc.calculateSeverity(q('HLT-03'), svc.parseRawAnswerValue(label, 'SINGLE_SELECT'), ls).score;
    expect(at('Never')).toBe(0);
    expect(at('Sometimes')).toBe(33);
    expect(at('Often')).toBe(67);
    expect(at('Always')).toBe(100);
  });

  it('maps a numeric answer onto floor..ceiling and clamps (HLT-02, 0-120 min)', () => {
    const ls = lookupsFor('HLT-02');
    const at = (v: number) =>
      svc.calculateSeverity(q('HLT-02'), svc.parseRawAnswerValue(v, 'NUMERIC'), ls).score;
    expect(at(0)).toBe(0);
    expect(at(60)).toBe(50);
    expect(at(120)).toBe(100);
    expect(at(500)).toBe(100); // clamped, never above 100
  });

  it('reverses direction where a higher value is better (HLT-04 antenatal visits)', () => {
    const ls = lookupsFor('HLT-04');
    const at = (v: number) =>
      svc.calculateSeverity(q('HLT-04'), svc.parseRawAnswerValue(v, 'NUMERIC'), ls).score;
    // 0 visits = the need is entirely unmet; 4+ visits = fully met.
    expect(at(0)).toBe(100);
    expect(at(2)).toBe(50);
    expect(at(4)).toBe(0);
    expect(at(9)).toBe(0); // clamped
  });

  it('scores a composite state as one state, not as the sum of its parts (INF-14)', () => {
    const ls = lookupsFor('INF-14');
    const r = svc.calculateSeverity(
      q('INF-14'),
      svc.parseRawAnswerValue(['Ventilation', 'Roof', 'Walls'], 'MULTI_SELECT'),
      ls,
    );
    expect(r.status).toBe('SCORED');
    expect(r.score).toBe(90);
  });

  it('resolves a composite state regardless of selection order (INF-14)', () => {
    const ls = lookupsFor('INF-14');
    const score = (opts: string[]) =>
      svc.calculateSeverity(q('INF-14'), svc.parseRawAnswerValue(opts, 'MULTI_SELECT'), ls).score;
    // The workbook lists "Ventilation; Roof; Walls" and "Ventilation; Walls;
    // Roof" as the same 90. Any permutation must agree.
    expect(score(['Walls', 'Ventilation', 'Roof'])).toBe(90);
    expect(score(['Roof', 'Walls', 'Ventilation'])).toBe(90);
  });

  it('falls back to a weighted sum capped at 100 for per-option multi-selects (EDU-07)', () => {
    const ls = lookupsFor('EDU-07');
    const at = (opts: string[]) =>
      svc.calculateSeverity(q('EDU-07'), svc.parseRawAnswerValue(opts, 'MULTI_SELECT'), ls).score;
    expect(at(['None'])).toBe(0);
    expect(at(['Early marriage'])).toBe(35);                          // single option
    expect(at(['Early marriage', 'Cultural norms'])).toBe(70);        // 35 + 35
    // 35 + 35 + 25 + 25 + 20 = 140, capped at 100.
    expect(at(['Early marriage', 'Cultural norms', 'Distance / safety',
               'Shortage of female teachers', 'Household burdens'])).toBe(100);
  });

  it('never scores a diagnostic item, even though it has coded options (HLT-19)', () => {
    // The 18 diagnostic items are fielded and coded, but feed gap-type
    // classification only — "does not enter the scores".
    const r = svc.calculateSeverity(
      q('HLT-19'),
      svc.parseRawAnswerValue(['Distance'], 'MULTI_SELECT'),
      lookupsFor('HLT-19'),
    );
    expect(r.status).toBe('NOT_SCOREABLE');
    expect(r.score).toBeNull();
  });

  it('never scores instrument scaffolding (XDM-04 metadata module)', () => {
    const r = svc.calculateSeverity(q('XDM-04'), svc.parseRawAnswerValue('anything', 'METADATA_MODULE'), []);
    expect(r.status).toBe('NOT_SCOREABLE');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('v5.0 conditional rules', () => {
  const answers = (pairs: Record<string, string>) =>
    new Map(Object.entries(pairs).map(([k, v]) => [k, svc.parseRawAnswerValue(v, 'SINGLE_SELECT')]));

  it('gates a branch on the parent answer (HLT-09 asked only if HLT-08 = Yes)', () => {
    expect(svc.evaluateConditionalRule(q('HLT-09'), answers({ 'HLT-08': 'Yes' }))).toBe(true);
    expect(svc.evaluateConditionalRule(q('HLT-09'), answers({ 'HLT-08': 'No' }))).toBe(false);
  });

  it('inverts a "skipped if" rule (WSH-02 skipped when water is piped indoors)', () => {
    expect(
      svc.evaluateConditionalRule(q('WSH-02'), answers({ 'WSH-01': 'Piped into the dwelling' })),
    ).toBe(false);
    expect(svc.evaluateConditionalRule(q('WSH-02'), answers({ 'WSH-01': 'Public tap' }))).toBe(true);
  });

  it('resolves prose values onto the parent\'s real options (EDU-05)', () => {
    // The workbook says "asked only if EDU-04 = Yes (once or repeatedly)", but
    // EDU-04's actual options are "No / Yes, once / Yes, repeatedly". Left
    // unresolved, this rule could never be true and every EDU-05 answer would be
    // silently discarded.
    expect(svc.evaluateConditionalRule(q('EDU-05'), answers({ 'EDU-04': 'Yes, once' }))).toBe(true);
    expect(svc.evaluateConditionalRule(q('EDU-05'), answers({ 'EDU-04': 'Yes, repeatedly' }))).toBe(true);
    expect(svc.evaluateConditionalRule(q('EDU-05'), answers({ 'EDU-04': 'No' }))).toBe(false);
  });

  it('treats a prose-only condition as applicable rather than dropping the answer', () => {
    // 19 of the 25 v5.0 rules are stated in prose the engine cannot evaluate
    // ("asked only if a birth occurred in the past 24 months"). Marking those
    // not-applicable would discard real data.
    const prose = bank.questions.find(
      (x) => x.conditionalRule?.operator === 'PROSE' && x.isScoreable,
    );
    expect(prose).toBeDefined();
    expect(svc.evaluateConditionalRule(q(prose!.questionId), new Map())).toBe(true);
  });

  it('every structured rule names a question that exists in this bank', () => {
    const codes = new Set(bank.questions.map((x) => x.questionId));
    for (const x of bank.questions) {
      const dep = x.conditionalRule?.dependsOn;
      if (dep) expect(codes.has(dep)).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('domain priority weights cover the whole methodology', () => {
  const rows = fs
    .readFileSync(path.join(DIR, 'domain-priority-v5.csv'), 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(1)
    .map((l) => l.split(','));

  it('includes all nine domains, not the five the pre-v5.0 file had', () => {
    expect(rows).toHaveLength(9);
    expect(rows.map((r) => r[1]).sort()).toEqual(bank.hierarchy.map((d) => d.name).sort());
  });

  it('weights are positive and sum to 1.00', () => {
    const total = rows.reduce((s, r) => s + parseFloat(r[2]!), 0);
    for (const r of rows) expect(parseFloat(r[2]!)).toBeGreaterThan(0);
    expect(Math.abs(total - 1)).toBeLessThan(0.001);
  });

  it('flags Health and Water & Sanitation as the critical-gap domains', () => {
    // Methodology §Priority Classification: "Critical Gap (severity 80+ with an
    // access/availability category in the Health or Water & Sanitation domains)".
    const critical = rows.filter((r) => r[3] === 'true').map((r) => r[1]).sort();
    expect(critical).toEqual(['Health', 'Water & Sanitation']);
  });
});
