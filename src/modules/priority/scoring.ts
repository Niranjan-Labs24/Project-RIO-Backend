// Priority Scoring — initial rule engine (RIO-Priority).
//
// Formula (per the methodology brief): Priority Score = Σ(Response Value ×
// Indicator Weight), normalized to a 0-100 severity, then mapped to a
// priority level via configurable thresholds. Every step below is its own
// function specifically so the methodology can change (real indicator
// weights, a real response-value mapping, a different normalization curve)
// without rewriting the engine around it — swap one function, not the
// pipeline.
//
// Where the real methodology isn't known yet, that's called out with an
// explicit TODO(RIO-Priority) rather than a silently-guessed constant.

export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';

export interface IndicatorContribution {
  indicator: string;
  weight: number;
  responseValue: number;
  weightedContribution: number;
}

export interface ScoringThresholds {
  // >= this severity is always Critical.
  criticalSeverity: number;
  // >= this severity is High.
  highSeverity: number;
  // >= this severity AND the equity flag is set is also High (a lower bar
  // than highSeverity, so an equity-flagged gap doesn't have to be as
  // severe on its own to be treated as urgent).
  equityHighSeverity: number;
  // >= this severity (and below highSeverity) is Medium; below it is Low.
  mediumSeverity: number;
}

// Matches the spec's exact bands: >=80 Critical, >=70 High, >=50 + equity
// flag High, 40-69 Medium, <40 Low. Configurable constants, not literals
// scattered through the mapping logic below — change these to retune
// without touching mapPriorityLevel itself.
export const DEFAULT_THRESHOLDS: ScoringThresholds = {
  criticalSeverity: 80,
  highSeverity: 70,
  equityHighSeverity: 50,
  mediumSeverity: 40,
};

export interface AnsweredIndicatorQuestion {
  indicator: string;
  answerType: string;
  // Every non-empty answer recorded for this question across the Need's
  // survey responses — the formula aggregates by averaging these into one
  // response value per indicator before weighting.
  rawAnswers: unknown[];
}

// STEP 1 — Response Value mapping: turn a raw citizen answer into a 0-1
// numeric value the formula can multiply by a weight.
//
// TODO(RIO-Priority): the real response-to-value mapping (e.g. does a
// specific multiple-choice option count as "high need" vs "low need"?) is
// not yet defined by the methodology package — this placeholder treats
// "yes"/an affirmative choice as full need (1), "no" as none (0), a numeric
///rating answer as its position within its own observed range, and any
// other free-text answer as a neutral half-value (a response exists, but
// its severity can't yet be judged). Replace this function alone once the
// real per-answer-type mapping is provided.
export function mapResponseValue(answerType: string, rawAnswer: unknown): number {
  if (rawAnswer === null || rawAnswer === undefined || rawAnswer === '') return 0;
  const text = String(rawAnswer).trim().toLowerCase();

  if (answerType === 'boolean' || answerType === 'yes_no') {
    if (text === 'yes' || text === 'true') return 1;
    if (text === 'no' || text === 'false') return 0;
    return 0.5;
  }

  if (answerType === 'rating') {
    const n = Number(rawAnswer);
    if (!Number.isNaN(n)) return Math.max(0, Math.min(1, (n - 1) / 4)); // 1-5 scale -> 0-1
  }

  if (answerType === 'numeric') {
    const n = Number(rawAnswer);
    if (!Number.isNaN(n)) return Math.max(0, Math.min(1, n / 100)); // treat as already a 0-100 severity-style figure
  }

  // select/multiple_choice/checkbox/short_text/long_text: no defined
  // severity ordering yet — a non-empty answer is scored as moderate need
  // rather than silently excluded.
  return 0.5;
}

function averageResponseValue(question: AnsweredIndicatorQuestion): number {
  const values = question.rawAnswers.map((a) => mapResponseValue(question.answerType, a));
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// STEP 2 — Indicator weight lookup.
//
// TODO(RIO-Priority): the Question Bank (see `Question` in schema.prisma)
// has no per-indicator weight column yet — only `indicator`/`kpi` labels.
// Until the real weights are added there, every indicator is weighted
// equally (1), which makes the formula an unweighted average rather than a
// true weighted one. Swap this for a real lookup (e.g. `question.weight`)
// once that column exists — nothing else in this file needs to change.
export function getIndicatorWeight(_indicator: string): number {
  return 1;
}

// STEP 3 — Normalization: raw Σ(value × weight) has no fixed ceiling on its
// own (it depends on how many indicators fed it), so it's normalized against
// the maximum possible weighted score for the same indicator set (every
// response value at its max of 1).
export function normalizeToSeverity(totalWeightedScore: number, maxPossibleWeightedScore: number): number {
  if (maxPossibleWeightedScore <= 0) return 0;
  const pct = (totalWeightedScore / maxPossibleWeightedScore) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// STEP 4 — Threshold mapping: severity + equity flag -> priority level.
export function mapPriorityLevel(
  severity: number,
  hasEquityFlag: boolean,
  thresholds: ScoringThresholds = DEFAULT_THRESHOLDS,
): PriorityLevel {
  if (severity >= thresholds.criticalSeverity) return 'critical';
  if (severity >= thresholds.highSeverity) return 'high';
  if (severity >= thresholds.equityHighSeverity && hasEquityFlag) return 'high';
  if (severity >= thresholds.mediumSeverity) return 'medium';
  return 'low';
}

// STEP 5 — Gap Type: Cycle 1's only implemented rule is "High severity ->
// Acute" — chronic/structural/seasonal/inequity_linked all need trend data
// across multiple assessment cycles, which doesn't exist yet. They're
// listed here as placeholders so the type is already shaped for them, not
// implemented.
export type GapType = 'acute' | 'chronic' | 'structural' | 'seasonal' | 'inequity_linked';

export function determineGapType(level: PriorityLevel, cycleNumber: number = 1): GapType {
  if (cycleNumber === 1) {
    // TODO(RIO-Priority): cycle 1 has no history to compare against, so
    // every high/critical gap is provisionally "acute" — chronic/
    // structural/seasonal/inequity_linked all require a later cycle's
    // trend to distinguish from a one-off spike.
    return 'acute';
  }
  // TODO(RIO-Priority): multi-cycle comparison not implemented yet.
  return 'acute';
}

export interface ScoredResult {
  contributions: IndicatorContribution[];
  totalWeightedScore: number;
  maxPossibleWeightedScore: number;
  severity: number;
  level: PriorityLevel;
  gapType: GapType;
}

// The full pipeline, in order — each step above stays independently
// testable/replaceable; this just wires them together.
export function scoreNeed(
  questions: AnsweredIndicatorQuestion[],
  hasEquityFlag: boolean,
  thresholds: ScoringThresholds = DEFAULT_THRESHOLDS,
): ScoredResult {
  const contributions: IndicatorContribution[] = questions.map((q) => {
    const weight = getIndicatorWeight(q.indicator);
    const responseValue = averageResponseValue(q);
    return {
      indicator: q.indicator,
      weight,
      responseValue,
      weightedContribution: Math.round(responseValue * weight * 100) / 100,
    };
  });

  const totalWeightedScore = contributions.reduce((sum, c) => sum + c.weightedContribution, 0);
  const maxPossibleWeightedScore = contributions.reduce((sum, c) => sum + c.weight, 0);
  const severity = normalizeToSeverity(totalWeightedScore, maxPossibleWeightedScore);
  const level = mapPriorityLevel(severity, hasEquityFlag, thresholds);
  const gapType = determineGapType(level);

  return { contributions, totalWeightedScore, maxPossibleWeightedScore, severity, level, gapType };
}
