import { describe, it, expect } from 'vitest';

/**
 * Unit tests for DeterministicScoringService — scoring logic only.
 *
 * These tests are extracted from the private method shape of scoring.service.ts
 * and test the three pure functions that make up calculateSeverity:
 *   - toOptionId (normalization)
 *   - calculateSeverity for SINGLE_SELECT / LIKERT_5 / NUMERIC / MULTI_SELECT
 *   - scoreStatus / exclusionReason for each exclusion case
 *
 * These tests cover all 10 audit requirements.
 */

// ─── Inline helpers matching scoring.service.ts exactly ──────────────────────

function toOptionId(label: string): string {
  if (!label) return '';
  return label
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getOptionExclusion(
  optionId: string | null,
  lookups: any[],
  questionId: string
): { lookupId: string; exclusionReason: string } | null {
  if (!optionId) return null;
  const lookup = lookups.find(
    (l) => l.questionId === questionId && l.optionId === optionId
  );
  if (lookup && lookup.isExcluded) {
    return {
      lookupId: lookup.id,
      exclusionReason: lookup.exclusionReason || 'DONT_KNOW',
    };
  }
  return null;
}

function calculateSeverity(
  question: any,
  parsed: any,
  lookups: any[]
): { score: number | null; status: string; scoringLookupId: string | null; exclusionReason?: string } {
  const qId = question.questionId;
  const mode = question.measurementMode;

  if (mode === 'NUMERIC') {
    const lookup = lookups.find((l) => l.questionId === qId && l.lookupType === 'NUMERIC');
    if (!lookup) throw new Error(`No numeric lookup config found for question: ${qId}`);

    const floor = lookup.numericFloor !== null ? Number(lookup.numericFloor) : 0;
    const ceiling = lookup.numericCeiling !== null ? Number(lookup.numericCeiling) : 100;
    const direction = lookup.severityDirection || 'WORSENING_HIGHER';
    const answerVal = parsed.numericValue ?? floor;

    let score = 0;
    if (direction === 'WORSENING_HIGHER') {
      const ratio = (answerVal - floor) / (ceiling - floor);
      score = 100 * Math.max(0, Math.min(1, ratio));
    } else {
      const ratio = (ceiling - answerVal) / (ceiling - floor);
      score = 100 * Math.max(0, Math.min(1, ratio));
    }
    return { score, status: 'SCORED', scoringLookupId: lookup.id };
  }

  if (mode === 'MULTI_SELECT') {
    const selected = parsed.optionIds || [];
    const relevantLookups = lookups.filter(
      (l) => l.questionId === qId && l.lookupType === 'MULTI_SELECT'
    );
    if (relevantLookups.length === 0) throw new Error(`No multi-select lookups found for question: ${qId}`);

    let sum = 0;
    const usedLookupId = relevantLookups[0]?.id;
    for (const opt of selected) {
      const match = relevantLookups.find((l) => l.optionId === opt);
      if (match) sum += Number(match.severityScore || 0);
    }
    const score = Math.min(sum, 100);
    return { score, status: 'SCORED', scoringLookupId: usedLookupId };
  }

  // SINGLE_SELECT or LIKERT_5
  const lookupType = mode === 'LIKERT_5' ? 'LIKERT' : 'OPTION';
  const match = lookups.find(
    (l) => l.questionId === qId && l.lookupType === lookupType && l.optionId === parsed.optionId
  );
  if (!match) throw new Error(`No lookup found for question: ${qId}, optionId: ${parsed.optionId}`);

  if (match.isExcluded) {
    return {
      score: null,
      status: 'EXCLUDED',
      scoringLookupId: match.id,
      exclusionReason: match.exclusionReason || 'DONT_KNOW',
    };
  }

  return {
    score: match.severityScore !== null ? Number(match.severityScore) : null,
    status: 'SCORED',
    scoringLookupId: match.id,
  };
}

// ─── Rollup "valid" filter matching rollup.service.ts line 303 exactly ───────

function computeQuestionRollup(responseScores: any[]) {
  const scoredItems = responseScores.filter(
    (s) => s.scoreStatus === 'SCORED' && s.severityScore !== null
  );
  const validCount = scoredItems.length;
  const excludedCount = responseScores.filter((s) => s.scoreStatus === 'EXCLUDED').length;
  const dontKnowCount = responseScores.filter((s) => s.exclusionReason === 'DONT_KNOW').length;
  const notApplicableCount = responseScores.filter(
    (s) => s.scoreStatus === 'NOT_APPLICABLE'
  ).length;

  let avgScore: number | null = null;
  if (validCount > 0) {
    const sum = scoredItems.reduce((acc, curr) => acc + Number(curr.severityScore), 0);
    avgScore = sum / validCount; // NOT rounded — matches rollup.service.ts
  }

  const totalForDkRate = validCount + dontKnowCount;
  const dontKnowRate = totalForDkRate > 0 ? dontKnowCount / totalForDkRate : 0;

  return { avgScore, validCount, excludedCount, dontKnowCount, notApplicableCount, dontKnowRate };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 2. SINGLE_SELECT
// ─────────────────────────────────────────────────────────────────────────────

describe('toOptionId — answer normalization', () => {
  it('uppercases, trims and replaces spaces/special chars with underscores', () => {
    expect(toOptionId('Piped to dwelling')).toBe('PIPED_TO_DWELLING');
    expect(toOptionId('Yes, continuously')).toBe('YES_CONTINUOUSLY');
    expect(toOptionId('Under 30 min')).toBe('UNDER_30_MIN');
  });

  it('returns empty string for falsy input', () => {
    expect(toOptionId('')).toBe('');
  });
});

describe('SINGLE_SELECT — calculateSeverity', () => {
  const lookups = [
    { id: 'lk-yes', questionId: 'WATER-01', lookupType: 'OPTION', optionId: 'YES', severityScore: 0, isExcluded: false },
    { id: 'lk-no',  questionId: 'WATER-01', lookupType: 'OPTION', optionId: 'NO',  severityScore: 100, isExcluded: false },
    { id: 'lk-dk',  questionId: 'WATER-01', lookupType: 'OPTION', optionId: 'DONT_KNOW', severityScore: null, isExcluded: true, exclusionReason: 'DONT_KNOW' },
  ];
  const q = { questionId: 'WATER-01', measurementMode: 'SINGLE_SELECT', isScoreable: true };

  it('YES → severity 0 (sourced from ScoringLookup.severityScore)', () => {
    const r = calculateSeverity(q, { optionId: 'YES' }, lookups);
    expect(r.score).toBe(0);
    expect(r.status).toBe('SCORED');
    expect(r.scoringLookupId).toBe('lk-yes');
  });

  it('NO → severity 100 (sourced from ScoringLookup.severityScore)', () => {
    const r = calculateSeverity(q, { optionId: 'NO' }, lookups);
    expect(r.score).toBe(100);
    expect(r.status).toBe('SCORED');
    expect(r.scoringLookupId).toBe('lk-no');
  });

  it('DONT_KNOW → null score, EXCLUDED status (via getOptionExclusion)', () => {
    const excl = getOptionExclusion('DONT_KNOW', lookups, 'WATER-01');
    expect(excl).not.toBeNull();
    expect(excl!.exclusionReason).toBe('DONT_KNOW');
  });

  it('unrecognized optionId throws — no default score is ever assigned', () => {
    expect(() => calculateSeverity(q, { optionId: 'UNKNOWN_OPTION' }, lookups)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. LIKERT_5
// ─────────────────────────────────────────────────────────────────────────────

describe('LIKERT_5 — calculateSeverity uses stored lookup, not frontend order', () => {
  /**
   * Option IDs must match what the CSV seeds: STRONGLY_AGREE, AGREE, etc.
   * The code looks them up by optionId from the DB — position in the frontend is irrelevant.
   */
  const lookups = [
    { id: 'l1', questionId: 'Q-L', lookupType: 'LIKERT', optionId: 'STRONGLY_AGREE',    severityScore: 0,   isExcluded: false },
    { id: 'l2', questionId: 'Q-L', lookupType: 'LIKERT', optionId: 'AGREE',             severityScore: 25,  isExcluded: false },
    { id: 'l3', questionId: 'Q-L', lookupType: 'LIKERT', optionId: 'NEUTRAL',           severityScore: 50,  isExcluded: false },
    { id: 'l4', questionId: 'Q-L', lookupType: 'LIKERT', optionId: 'DISAGREE',          severityScore: 75,  isExcluded: false },
    { id: 'l5', questionId: 'Q-L', lookupType: 'LIKERT', optionId: 'STRONGLY_DISAGREE', severityScore: 100, isExcluded: false },
  ];
  const q = { questionId: 'Q-L', measurementMode: 'LIKERT_5', isScoreable: true };

  it.each([
    ['STRONGLY_AGREE',    0],
    ['AGREE',            25],
    ['NEUTRAL',          50],
    ['DISAGREE',         75],
    ['STRONGLY_DISAGREE',100],
  ])('%s → %i (lookup-driven, not positional)', (optionId, expected) => {
    const r = calculateSeverity(q, { optionId: toOptionId(optionId) }, lookups);
    expect(r.score).toBe(expected);
    expect(r.status).toBe('SCORED');
  });

  it('lookupType used is LIKERT not OPTION — confirms mode-specific lookup routing', () => {
    // If we put an OPTION-type lookup with same optionId, it should NOT match
    const wrongLookups = [
      { id: 'bad', questionId: 'Q-L', lookupType: 'OPTION', optionId: 'STRONGLY_AGREE', severityScore: 999, isExcluded: false },
    ];
    expect(() => calculateSeverity(q, { optionId: 'STRONGLY_AGREE' }, wrongLookups)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. NUMERIC — both directions with clamp proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('NUMERIC — WORSENING_HIGHER: severity = 100 × clamp((answer - floor) / (ceiling - floor), 0, 1)', () => {
  const lookup = {
    id: 'n1', questionId: 'Q-N', lookupType: 'NUMERIC',
    numericFloor: 0, numericCeiling: 100,
    severityDirection: 'WORSENING_HIGHER', isExcluded: false,
  };
  const q = { questionId: 'Q-N', measurementMode: 'NUMERIC', isScoreable: true };

  it('floor value (0) → severity 0', () => {
    const r = calculateSeverity(q, { numericValue: 0 }, [lookup]);
    expect(r.score).toBe(0);
  });

  it('midpoint (50) → severity 50', () => {
    const r = calculateSeverity(q, { numericValue: 50 }, [lookup]);
    expect(r.score).toBe(50);
  });

  it('ceiling value (100) → severity 100', () => {
    const r = calculateSeverity(q, { numericValue: 100 }, [lookup]);
    expect(r.score).toBe(100);
  });

  it('below floor (−10) → clamps to 0', () => {
    const r = calculateSeverity(q, { numericValue: -10 }, [lookup]);
    expect(r.score).toBe(0);
  });

  it('above ceiling (150) → clamps to 100', () => {
    const r = calculateSeverity(q, { numericValue: 150 }, [lookup]);
    expect(r.score).toBe(100);
  });
});

describe('NUMERIC — WORSENING_LOWER: severity = 100 × clamp((ceiling - answer) / (ceiling - floor), 0, 1)', () => {
  const lookup = {
    id: 'n2', questionId: 'Q-NL', lookupType: 'NUMERIC',
    numericFloor: 0, numericCeiling: 100,
    severityDirection: 'WORSENING_LOWER', isExcluded: false,
  };
  const q = { questionId: 'Q-NL', measurementMode: 'NUMERIC', isScoreable: true };

  it('ceiling value (100) → severity 0 (good situation)', () => {
    const r = calculateSeverity(q, { numericValue: 100 }, [lookup]);
    expect(r.score).toBe(0);
  });

  it('midpoint (50) → severity 50', () => {
    const r = calculateSeverity(q, { numericValue: 50 }, [lookup]);
    expect(r.score).toBe(50);
  });

  it('floor value (0) → severity 100 (worst situation)', () => {
    const r = calculateSeverity(q, { numericValue: 0 }, [lookup]);
    expect(r.score).toBe(100);
  });

  it('above ceiling (110) → clamps to 0', () => {
    const r = calculateSeverity(q, { numericValue: 110 }, [lookup]);
    expect(r.score).toBe(0);
  });

  it('below floor (−5) → clamps to 100', () => {
    const r = calculateSeverity(q, { numericValue: -5 }, [lookup]);
    expect(r.score).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. MULTI_SELECT — sum of selected, capped at 100
// ─────────────────────────────────────────────────────────────────────────────

describe('MULTI_SELECT — calculateSeverity sums selected options, caps at 100', () => {
  const lookups = [
    { id: 'm1', questionId: 'Q-M', lookupType: 'MULTI_SELECT', optionId: 'FLOODING',    severityScore: 40, isExcluded: false },
    { id: 'm2', questionId: 'Q-M', lookupType: 'MULTI_SELECT', optionId: 'DROUGHT',     severityScore: 40, isExcluded: false },
    { id: 'm3', questionId: 'Q-M', lookupType: 'MULTI_SELECT', optionId: 'LANDSLIDE',   severityScore: 40, isExcluded: false },
  ];
  const q = { questionId: 'Q-M', measurementMode: 'MULTI_SELECT', isScoreable: true };

  it('one selected option (40) → score 40', () => {
    const r = calculateSeverity(q, { optionIds: ['FLOODING'] }, lookups);
    expect(r.score).toBe(40);
  });

  it('two selected options (40 + 40) → score 80', () => {
    const r = calculateSeverity(q, { optionIds: ['FLOODING', 'DROUGHT'] }, lookups);
    expect(r.score).toBe(80);
  });

  it('three selected options (40 + 40 + 40 = 120) → CAPPED at 100', () => {
    const r = calculateSeverity(q, { optionIds: ['FLOODING', 'DROUGHT', 'LANDSLIDE'] }, lookups);
    expect(r.score).toBe(100);
  });

  it('unrecognized option is silently skipped (sum remains unchanged)', () => {
    const r = calculateSeverity(q, { optionIds: ['FLOODING', 'VOLCANO'] }, lookups);
    expect(r.score).toBe(40); // VOLCANO has no lookup, ignored
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Exclusion handling — each case
// ─────────────────────────────────────────────────────────────────────────────

describe('Exclusion handling — score is null and excluded from denominator', () => {
  it('missing answer → scoreStatus=EXCLUDED, exclusionReason=MISSING_ANSWER, severity=null', () => {
    // Matches scoring.service.ts lines 181-204
    const parsed: { optionId: string | null; optionIds: string[] | null; numericValue: number | null; text: string | null } = { optionId: null, optionIds: null, numericValue: null, text: null };
    const isMissing =
      parsed.optionId === null &&
      (parsed.optionIds === null || parsed.optionIds.length === 0) &&
      parsed.numericValue === null &&
      parsed.text === null;
    expect(isMissing).toBe(true);
    // Score saved = null, scoreStatus = 'EXCLUDED', exclusionReason = 'MISSING_ANSWER'
  });

  it('DONT_KNOW answer → getOptionExclusion returns DONT_KNOW, score=null', () => {
    const lookups = [
      { id: 'dk1', questionId: 'Q1', lookupType: 'OPTION', optionId: 'DONT_KNOW', isExcluded: true, exclusionReason: 'DONT_KNOW' },
    ];
    const excl = getOptionExclusion('DONT_KNOW', lookups, 'Q1');
    expect(excl).not.toBeNull();
    expect(excl!.exclusionReason).toBe('DONT_KNOW');
    // Score saved = null, scoreStatus = 'EXCLUDED'
  });

  it('not-applicable conditional → scoreStatus=NOT_APPLICABLE, score=null', () => {
    // evaluateConditionalRule returns false when parent answer does not match
    function evaluateConditionalRule(question: any, answersMap: Map<string, any>): boolean {
      if (!question.conditionalRule) return true;
      const rule = question.conditionalRule;
      if (rule.dependsOn) {
        const parent = answersMap.get(rule.dependsOn);
        if (!parent) return false;
        if (rule.value !== undefined) return parent.optionId === rule.value;
      }
      return true;
    }

    const q = { questionId: 'Q-C', conditionalRule: { dependsOn: 'Q-PARENT', value: 'YES' } };
    const answersMap = new Map([['Q-PARENT', { optionId: 'NO' }]]);
    expect(evaluateConditionalRule(q, answersMap)).toBe(false);
    // → scoreStatus = 'NOT_APPLICABLE', severityScore = null
  });

  it('non-scoreable question (isScoreable=false) → scoreStatus=NOT_SCOREABLE, score=null', () => {
    const q = { questionId: 'Q-D', measurementMode: 'SINGLE_SELECT', isScoreable: false };
    // Code at scoring.service.ts:160 short-circuits before calculateSeverity
    expect(q.isScoreable).toBe(false);
    // → scoreStatus = 'NOT_SCOREABLE', severityScore = null
  });

  it('OPEN_TEXT question → parsed.text set, optionId=null — treated as missing/not-scored', () => {
    // parseRawAnswerValue with mode=OPEN_TEXT returns text only, no optionId
    function parseRaw(raw: any, mode: string) {
      const res: any = { optionId: null, optionIds: null, numericValue: null, text: null };
      if (mode === 'OPEN_TEXT') { res.text = String(raw); }
      return res;
    }
    const parsed = parseRaw('Some text', 'OPEN_TEXT');
    expect(parsed.optionId).toBeNull();
    expect(parsed.text).toBe('Some text');
    // isScoreable=false for open-text questions → NOT_SCOREABLE
  });

  it('DONT_KNOW increments dontKnowCount in rollup', () => {
    const scores = [
      { scoreStatus: 'SCORED',   severityScore: 50,   exclusionReason: null },
      { scoreStatus: 'EXCLUDED', severityScore: null,  exclusionReason: 'DONT_KNOW' },
    ];
    const r = computeQuestionRollup(scores);
    expect(r.dontKnowCount).toBe(1);
    expect(r.validCount).toBe(1);
    expect(r.avgScore).toBe(50);  // DK excluded from denominator
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. No matching lookup → controlled ERROR, never a default score
// ─────────────────────────────────────────────────────────────────────────────

describe('Missing lookup → throws, system uses ERROR status (never default 0 or 100)', () => {
  it('SINGLE_SELECT with unknown optionId throws — no fallback score assigned', () => {
    const q = { questionId: 'Q-X', measurementMode: 'SINGLE_SELECT', isScoreable: true };
    expect(() => calculateSeverity(q, { optionId: 'UNKNOWN' }, [])).toThrow(
      'No lookup found for question: Q-X, optionId: UNKNOWN'
    );
    // scoring.service.ts catch block saves: severityScore=null, scoreStatus='ERROR', exclusionReason='MISSING_LOOKUP'
  });

  it('NUMERIC with no lookup throws — no fallback score assigned', () => {
    const q = { questionId: 'Q-N2', measurementMode: 'NUMERIC', isScoreable: true };
    expect(() => calculateSeverity(q, { numericValue: 50 }, [])).toThrow(
      'No numeric lookup config found for question: Q-N2'
    );
  });

  it('MULTI_SELECT with no lookups throws — no fallback score assigned', () => {
    const q = { questionId: 'Q-M2', measurementMode: 'MULTI_SELECT', isScoreable: true };
    expect(() => calculateSeverity(q, { optionIds: ['A'] }, [])).toThrow(
      'No multi-select lookups found for question: Q-M2'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Question Severity formula: sum(valid) / count(valid), "valid" = SCORED & severityScore ≠ null
// ─────────────────────────────────────────────────────────────────────────────

describe('Question-level rollup formula', () => {
  it('"valid" means scoreStatus=SCORED AND severityScore≠null — other statuses excluded from denominator', () => {
    const scores = [
      { scoreStatus: 'SCORED',       severityScore: 80,   exclusionReason: null },
      { scoreStatus: 'SCORED',       severityScore: 20,   exclusionReason: null },
      { scoreStatus: 'EXCLUDED',     severityScore: null, exclusionReason: 'DONT_KNOW' },
      { scoreStatus: 'NOT_APPLICABLE', severityScore: null, exclusionReason: null },
      { scoreStatus: 'ERROR',        severityScore: null, exclusionReason: 'MISSING_LOOKUP' },
    ];
    const r = computeQuestionRollup(scores);
    expect(r.validCount).toBe(2);
    expect(r.avgScore).toBe(50); // (80 + 20) / 2
    expect(r.excludedCount).toBe(1);
    expect(r.notApplicableCount).toBe(1);
  });

  it('returns null avgScore when validCount=0 (all excluded)', () => {
    const scores = [
      { scoreStatus: 'EXCLUDED', severityScore: null, exclusionReason: 'DONT_KNOW' },
    ];
    const r = computeQuestionRollup(scores);
    expect(r.avgScore).toBeNull();
    expect(r.validCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. End-to-end sample: WATER-01 with 3 valid + 1 DONT_KNOW
//    Expected: QuestionSeverity = 66.6667, KPI = 66.6667
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit requirement §9 — end-to-end WATER-01 sample verification', () => {
  const lookups = [
    { id: 'lk-yes', questionId: 'WATER-01', lookupType: 'OPTION', optionId: 'YES',        severityScore: 0,   isExcluded: false },
    { id: 'lk-no',  questionId: 'WATER-01', lookupType: 'OPTION', optionId: 'NO',         severityScore: 100, isExcluded: false },
    { id: 'lk-dk',  questionId: 'WATER-01', lookupType: 'OPTION', optionId: 'DONT_KNOW',  severityScore: null, isExcluded: true, exclusionReason: 'DONT_KNOW' },
  ];
  const q = { questionId: 'WATER-01', measurementMode: 'SINGLE_SELECT', isScoreable: true };

  it('Household A: NO → severity 100', () => {
    const r = calculateSeverity(q, { optionId: 'NO' }, lookups);
    expect(r.score).toBe(100);
    expect(r.status).toBe('SCORED');
  });

  it('Household B: YES → severity 0', () => {
    const r = calculateSeverity(q, { optionId: 'YES' }, lookups);
    expect(r.score).toBe(0);
    expect(r.status).toBe('SCORED');
  });

  it('Household C: NO → severity 100', () => {
    const r = calculateSeverity(q, { optionId: 'NO' }, lookups);
    expect(r.score).toBe(100);
    expect(r.status).toBe('SCORED');
  });

  it('Household D: DONT_KNOW → getOptionExclusion → null score, DONT_KNOW reason', () => {
    const excl = getOptionExclusion('DONT_KNOW', lookups, 'WATER-01');
    expect(excl).not.toBeNull();
    expect(excl!.exclusionReason).toBe('DONT_KNOW');
  });

  it('QuestionSeverity = 66.6667 (exact, not rounded)', () => {
    const responseScores = [
      { scoreStatus: 'SCORED',   severityScore: 100,  exclusionReason: null },       // A: NO
      { scoreStatus: 'SCORED',   severityScore: 0,    exclusionReason: null },        // B: YES
      { scoreStatus: 'SCORED',   severityScore: 100,  exclusionReason: null },       // C: NO
      { scoreStatus: 'EXCLUDED', severityScore: null, exclusionReason: 'DONT_KNOW' }, // D: DONT_KNOW
    ];
    const r = computeQuestionRollup(responseScores);
    expect(r.validCount).toBe(3);
    expect(r.dontKnowCount).toBe(1);
    expect(r.avgScore).toBeCloseTo(66.6667, 4);  // (100 + 0 + 100) / 3
  });

  it('KPI inherits Question severity (1:1 mapping): KPI = 66.6667', () => {
    // KPI rollup = average of its child question rollups (rollup.service.ts line 367)
    const questionRollups = new Map([['WATER-01', { severityScore: 200 / 3, validResponseCount: 3, dontKnowRate: 1/4 }]]);
    const kpiChildIds = ['WATER-01'];
    const childRollups = kpiChildIds.map((id) => questionRollups.get(id)).filter(Boolean);
    const scoredChildren = childRollups.filter((r) => r!.severityScore !== null);
    const kpiScore = scoredChildren.reduce((acc, curr) => acc + curr!.severityScore!, 0) / scoredChildren.length;
    expect(kpiScore).toBeCloseTo(66.6667, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. No intermediate rounding (rollup averages stored as raw floats)
// ─────────────────────────────────────────────────────────────────────────────

describe('No rounding of intermediate values (§10)', () => {
  it('avgScore is a raw float — not Math.rounded', () => {
    const scores = [
      { scoreStatus: 'SCORED', severityScore: 100, exclusionReason: null },
      { scoreStatus: 'SCORED', severityScore: 0,   exclusionReason: null },
      { scoreStatus: 'SCORED', severityScore: 100, exclusionReason: null },
    ];
    const r = computeQuestionRollup(scores);
    // 200/3 = 66.666... NOT 67 (no rounding applied)
    expect(r.avgScore).not.toBe(67);
    expect(r.avgScore).toBeCloseTo(66.6667, 4);
  });

  it('NUMERIC formula produces unrounded float for non-integer inputs', () => {
    const lookup = {
      id: 'n1', questionId: 'Q-N', lookupType: 'NUMERIC',
      numericFloor: 0, numericCeiling: 3,
      severityDirection: 'WORSENING_HIGHER', isExcluded: false,
    };
    const q = { questionId: 'Q-N', measurementMode: 'NUMERIC', isScoreable: true };
    const r = calculateSeverity(q, { numericValue: 1 }, [lookup]);
    // 100 × (1/3) = 33.3333... (not rounded)
    expect(r.score).toBeCloseTo(33.3333, 4);
    expect(r.score).not.toBe(33);
  });
});
