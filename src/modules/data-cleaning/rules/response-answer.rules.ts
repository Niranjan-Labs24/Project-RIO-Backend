// RIO-FR-002 / Q12 — "numeric units as defined in the question bank", applied
// to the answers a citizen actually submitted.
//
// ─── Why this rule earns its place ─────────────────────────────────────────
// DeterministicScoringService.parseRawAnswerValue turns a NUMERIC answer into
// a value with `Number(raw)`. That means every one of these becomes NaN, and
// then null:
//
//     "5 km"      "1,200"      "٥"      "~5"      "12,5"      "200 SAR"
//
// A null numericValue is not scored. So an answer written in any of those
// perfectly ordinary ways is SILENTLY DROPPED from the severity score, with no
// error and nothing in the response to say a value went missing. That is not a
// tidiness problem — it is a scoring-correctness problem, and surfacing it is
// the most valuable thing this rule does.
//
// ─── Why the scoring floor/ceiling is NOT used as a validity range ─────────
// ScoringLookup.numericFloor/numericCeiling look like validation bounds and
// are not. Read against the real v5 question bank:
//
//     HLT-04  ceiling 4     antenatal visits — the methodology's "4+ is best"
//                           cap. A fifth visit is excellent, not invalid.
//     INF-09  floor 2       bedrooms — a one-bedroom household is the WORST
//                           case the scale measures, not a bad data entry.
//     HLT-25  ceiling 2000  SAR — a household can genuinely pay more.
//
// They are the conversion scale for scoring (see the priority_factor_scales
// comment in 20260827100000_fr003_priority_scoring: "what a raw figure is
// worth out of 100"). Range-checking against them would flag correct answers
// as out-of-range across most of the bank. They are carried into the flag's
// `detail` as context for the reviewer, and nothing more.
//
// A negative value IS flagged: every numeric question in the bank is a count,
// a duration, a distance or an amount, and none of those can be below zero.

import type { CleaningContext } from "../cleaning-context.service";
import type { PendingFlag } from "../data-cleaning.types";
import { normalizeNumber, type UnitKey } from "../normalizers";

export interface NumericQuestionSpec {
  /** The methodology's own code, e.g. "HLT-02". */
  questionCode: string;
  questionText: string;
  expectedUnit: UnitKey | null;
  scoringFloor: number | null;
  scoringCeiling: number | null;
}

export interface RawNumericAnswer {
  /** Key into SurveyResponse.answers — needed to write a correction back. */
  surveyQuestionId: string;
  spec: NumericQuestionSpec;
  raw: unknown;
}

/**
 * The unit a numeric question is asking for, read from its own text.
 *
 * Deliberately conservative: a unit is assigned only when the question states
 * one in words. Where it does not, the result is null, which means "strip a
 * unit the respondent wrote, but never convert" — guessing from the scoring
 * ceiling (is a ceiling of 5 kilometres or miles?) would be inventing
 * methodology.
 *
 * Known gap worth raising with the client: EDU-02 asks for "the approximate
 * distance from this household to the nearest primary school" and names no
 * unit at all, so an answer of "500" is unreadable — 500 metres or 500 km. The
 * question bank has to say which; this code will not decide it.
 */
export function deriveExpectedUnit(questionText: string): UnitKey | null {
  const text = questionText.toLowerCase();
  if (text.includes("how many minutes") || text.includes("minutes one way")) return "minutes";
  if (text.includes("calendar days") || text.includes("how many days")) return "days";
  if (text.includes("how many of the past 12 months") || text.includes("how many months")) {
    return "months";
  }
  if (text.includes("saudi riyals")) return "sar";
  // Some items DO name a distance unit in parentheses — "(in km)". Matched
  // explicitly rather than inferred from the word "distance", because the
  // items that only say "distance" name no unit at all and must stay null.
  if (/\(\s*in\s+km\s*\)|in kilometres?|in kilometers?/.test(text)) return "km";
  if (/\(\s*in\s+(?:m|metres|meters)\s*\)/.test(text)) return "m";
  // "how much did/does ... pay/spend/was paid" with no other unit named is a
  // currency question throughout this bank.
  if (/how much (?:did|does|was)/.test(text)) return "sar";
  return null;
}

export function evaluateNumericAnswers(
  responseId: string,
  answers: RawNumericAnswer[],
  context: CleaningContext,
): PendingFlag[] {
  const flags: PendingFlag[] = [];

  for (const answer of answers) {
    if (answer.raw === null || answer.raw === undefined || answer.raw === "") continue;
    const raw = String(answer.raw);

    // The field names the QUESTION, not the row: a failed parse leaves no
    // ResponseAnswer row to point at (parseRawAnswerValue writes null for
    // both numericValue and text on a NUMERIC question), so the flag hangs
    // off the survey response and identifies the answer by question code.
    const field = `answers[${answer.spec.questionCode}]`;

    const result = normalizeNumber(raw, {
      field,
      required: false,
      dontKnowTreatment: context.settings.dontKnowTreatment,
      expectedUnit: answer.spec.expectedUnit,
      // Deliberately not the scoring bounds — see this file's header.
      floor: null,
      ceiling: null,
    });

    const base = {
      entityType: "survey_response" as const,
      entityId: responseId,
      rowNumber: null,
      field,
    };

    const detail = {
      questionCode: answer.spec.questionCode,
      questionText: answer.spec.questionText,
      surveyQuestionId: answer.surveyQuestionId,
      expectedUnit: answer.spec.expectedUnit,
      scoringScale: {
        floor: answer.spec.scoringFloor,
        ceiling: answer.spec.scoringCeiling,
      },
      // Says out loud what is at stake, so the queue explains itself.
      droppedFromScoring: result.value === null,
    };

    if (result.flag) {
      flags.push({
        ...base,
        ...result.flag,
        detail: { ...(result.flag.detail ?? {}), ...detail },
      });
      continue;
    }

    if (result.value !== null && result.value < 0) {
      flags.push({
        ...base,
        ruleCode: "NUMBER_OUT_OF_RANGE",
        severity: "non_standard",
        originalValue: raw,
        // No proposal: there is no honest way to turn a negative count into
        // the number the respondent meant.
        proposedValue: null,
        confidence: null,
        detail: { ...detail, reason: "negative_value" },
      });
    }
  }

  return flags;
}
