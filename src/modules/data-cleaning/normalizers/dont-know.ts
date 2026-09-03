// RIO-FR-002 / Q13 — "Don't know" is an ANSWER, not a gap.
//
// The client's ruling, in their words: the <10 respondents / >20% "Don't know"
// threshold on the Priority Scoring sheet is a STATISTICAL CONFIDENCE FLAG —
// it tags a result as low-confidence, it does not define "missing" for
// cleaning. And per the ratified LIV-21 treatment, "Prefer not to answer" is
// coded DK/NA and excluded from scoring rather than treated as a gap to fill.
//
// So a DK answer must never raise MISSING_REQUIRED. Counting it as missing
// would put thousands of correctly-answered questions in the reviewer's queue
// with nothing anyone could do about them, and would misreport completeness.
//
// The client asked us to CONFIRM before extending LIV-21 platform-wide, so the
// treatment is a setting (methodology_configs.data_cleaning_settings
// .dontKnowTreatment) defaulted to their expected answer. If they come back
// with "treat it as missing", that is a value change on an admin screen.

import { foldText } from "./fold-text";

export type DontKnowTreatment = "excluded_answer" | "missing_value";

/**
 * Every spelling of "don't know" / "prefer not to answer" the question bank
 * and the field forms actually use, in both languages. Compared FOLDED, so
 * "لا أعرف" and "لا اعرف" are one entry, and "Don't Know" / "dont know" /
 * "DON'T KNOW" collapse to the same key.
 */
const DONT_KNOW_SOURCES = [
  // English — the question bank's own option labels.
  // "Don't know" and "Dont know" are BOTH needed: folding turns the
  // apostrophe into a space, so the first yields the key "don t know" and the
  // second "dont know". They are two different keys, and field data contains
  // both spellings.
  "Don't know",
  "Dont know",
  "Do not know",
  "DK",
  "N/A",
  "NA",
  "Not applicable",
  "Not available",
  "Prefer not to answer",
  "No answer",
  "No response",
  "Refused",
  "Unknown",
  // Arabic
  "لا أعرف",
  "لا أعلم",
  "لا اعرف",
  "غير معروف",
  "غير متاح",
  "غير منطبق",
  "لا ينطبق",
  "أفضل عدم الإجابة",
  "أفضل عدم الاجابة",
  "لم يجب",
  "رفض الإجابة",
];

const DONT_KNOW_KEYS: ReadonlySet<string> = new Set(
  DONT_KNOW_SOURCES.map(foldText),
);

/**
 * True when a raw answer is a "don't know" / refusal token rather than data.
 *
 * Note "0" is deliberately NOT here: zero is a real measurement (zero clinics,
 * zero school days missed) and several question-bank items list it as an
 * explicit option alongside "Don't know". Treating it as an absent answer
 * would delete exactly the findings a needs assessment exists to surface.
 */
export function isDontKnow(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const folded = foldText(raw);
  if (!folded) return false;
  return DONT_KNOW_KEYS.has(folded);
}

export type PresenceVerdict =
  // A real value to normalize.
  | "present"
  // Nothing there. Raise MISSING_REQUIRED if the rule set requires the field.
  | "absent"
  // Answered "don't know". Under the confirmed treatment this is a real
  // answer that scoring excludes — never a cleaning flag.
  | "excluded";

/**
 * The single place that decides whether a raw field value is data, a gap, or a
 * DK answer. Every normalizer routes through it so the Q13 rule is applied
 * once rather than re-derived per field.
 */
export function classifyPresence(
  raw: string | null | undefined,
  treatment: DontKnowTreatment,
): PresenceVerdict {
  if (raw === null || raw === undefined || raw.trim() === "") return "absent";
  if (isDontKnow(raw)) {
    return treatment === "excluded_answer" ? "excluded" : "absent";
  }
  return "present";
}
