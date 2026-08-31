// The single place any 0–100 score becomes a band, and the single place a
// confidence rating is turned into a sentence.
//
// Three files previously inlined their own thresholds (report-summary.service,
// snapshot-to-content, priority-v2) which is how the same figure could render
// as HIGH in a table and MEDIUM in a narrative on the same page.

import { DEFAULT_THRESHOLDS, type SeverityBand, type Thresholds } from "../need-record.types";
import { DEFAULT_APP_LOCALE, type AppLocale } from "../../../i18n/locale";
import { translate } from "../../../i18n/translate";

export type { SeverityBand, Thresholds };
export { DEFAULT_THRESHOLDS };

export type DontKnowBand = "negligible" | "moderate" | "elevated" | "high";

/** null in → null out. A score of exactly 0 is LOW, not null. */
export function severityBandOf(score: number | null): SeverityBand | null {
  if (score === null) return null;
  if (score >= 70) return "CRITICAL";
  if (score >= 50) return "HIGH";
  if (score >= 30) return "MEDIUM";
  return "LOW";
}

/**
 * Priority is PERFORMANCE-weighted, so the banding is inverted vs severity:
 * a LOW priority score means high urgency. Rendered with
 * PRIORITY_DIRECTION_NOTE so the two scales on one page can't be misread.
 */
export function priorityStatusOf(score: number | null): "HIGH" | "MEDIUM" | "LOW" | null {
  if (score === null) return null;
  if (score <= 40) return "HIGH";
  if (score <= 70) return "MEDIUM";
  return "LOW";
}

/** Printed next to every Priority Score. Severity and priority run in opposite
 *  directions; saying so is cheaper than a reader drawing the wrong conclusion. */
export const PRIORITY_DIRECTION_NOTE =
  "The Village Priority Score is performance-based: LOWER means more urgent. It runs opposite to both the Severity scores and the per-need Priority Score column on this page, where HIGHER means more urgent.";

/** The same note in the report's own language. The English constant above is
 *  kept as-is so existing callers and their fixtures are untouched; new render
 *  paths should call this instead. */
export function priorityDirectionNote(locale: AppLocale = DEFAULT_APP_LOCALE): string {
  return translate(locale, "note.priorityDirection");
}

/**
 * Band values are STORED and COMPARED in English — they are the vocabulary the
 * scoring code, the prompts and the database all agree on, and translating them
 * at rest would break every comparison that depends on them.
 *
 * These three functions translate at the RENDER boundary only, which is the
 * whole design: an Arabic report shows an Arabic band because a lookup table
 * said so, never because a model decided so (RIO-I18N-003 §6).
 */
export function severityBandLabel(band: SeverityBand, locale: AppLocale = DEFAULT_APP_LOCALE): string {
  return translate(locale, `band.severity.${band}` as const);
}

export function priorityStatusLabel(
  status: "HIGH" | "MEDIUM" | "LOW",
  locale: AppLocale = DEFAULT_APP_LOCALE,
): string {
  return translate(locale, `band.priority.${status}` as const);
}

export function confidenceFlagLabel(
  flag: "LOW" | "STANDARD",
  locale: AppLocale = DEFAULT_APP_LOCALE,
): string {
  return translate(locale, `band.confidence.${flag}` as const);
}

export function dontKnowBandLabel(band: DontKnowBand, locale: AppLocale = DEFAULT_APP_LOCALE): string {
  return translate(locale, `band.dontKnow.${band}` as const);
}

/** Backend decides the adjective; the prompt must use it verbatim. */
export function dontKnowBandOf(rate: number): DontKnowBand {
  const pct = rate * 100;
  if (pct < 5) return "negligible";
  if (pct < 15) return "moderate";
  if (pct <= 25) return "elevated";
  return "high";
}

/**
 * Names only the condition that actually fired.
 *
 * The old fixed string claimed a high don't-know rate whenever confidence was
 * LOW — false whenever LOW came from sample size, which is the common case (the
 * demo survey: n=4, don't-know 3.13%). The snapshot handed that false premise to
 * Gemini, which faithfully combined it with the real 3.13% and produced a
 * self-contradicting sentence. Fixing the wording in the prompt would not have
 * helped; the premise was wrong before the prompt saw it.
 */
export function composeConfidenceReason(input: {
  validResponseCount: number;
  dontKnowRate: number;
  thresholds: Thresholds;
  /** RIO-FR-024: the Study's own computed sample-size target (Cochran +
   *  finite population correction), if one was captured at study creation. */
  requiredSampleSize?: number | null;
  /**
   * Which language to compose the sentence in. Defaults to English, so every
   * existing caller is unchanged.
   *
   * This sentence is quoted VERBATIM by the report prompts — the model is
   * explicitly forbidden from rewriting it, because doing so is what once
   * turned a 3.13% don't-know rate into the word "high". So it must arrive
   * already in the report's language. Translating it here, from the condition
   * that actually fired, is the only way to keep both properties at once:
   * verbatim-quotable AND Arabic (RIO-I18N-003 §6.1).
   */
  locale?: AppLocale;
}): string {
  const { validResponseCount: n, dontKnowRate, thresholds: t, requiredSampleSize } = input;
  const locale = input.locale ?? DEFAULT_APP_LOCALE;
  const reasons: string[] = [];
  let sampleReasonFired = false;

  // Percentages are formatted here, in code, and passed in as parameters. The
  // catalogue never sees a number it has to format, so a translator cannot
  // accidentally change a figure while editing a sentence.
  const ratePct = (dontKnowRate * 100).toFixed(2);

  if (n < t.confidenceMinSample) {
    reasons.push(
      translate(locale, "confidence.smallSample", { n, required: t.confidenceMinSample }),
    );
    sampleReasonFired = true;
  } else if (requiredSampleSize != null && n < requiredSampleSize) {
    // RIO-FR-024 dual confidence criterion: below the absolute floor above,
    // OR below the study's own population-based required sample — checked
    // as `else if` since both conditions describe the same "too few
    // responses" fact and would otherwise duplicate the reason.
    reasons.push(
      translate(locale, "confidence.belowCoverageTarget", { n, required: requiredSampleSize }),
    );
    sampleReasonFired = true;
  }
  if (dontKnowRate > t.dontKnowLowThreshold) {
    reasons.push(
      translate(locale, "confidence.elevatedDontKnow", {
        rate: ratePct,
        threshold: (t.dontKnowLowThreshold * 100).toFixed(0),
      }),
    );
  }

  if (reasons.length === 0) return translate(locale, "confidence.highCompleteness");

  // When only the sample-size condition fired, say so — and say the DK rate did NOT contribute.
  if (reasons.length === 1 && sampleReasonFired) {
    reasons.push(
      translate(locale, "confidence.dontKnowDidNotContribute", {
        rate: ratePct,
        // The band name is itself translated — an Arabic sentence carrying the
        // English word "negligible" is the exact leak this work removes.
        band: dontKnowBandLabel(dontKnowBandOf(dontKnowRate), locale),
      }),
    );
  }
  return reasons.join(" ");
}

/** The flag itself, from the same conditions the reason describes. Keeping
 *  flag and reason derived from the same inputs is what stops them disagreeing.
 *
 *  RIO-FR-024 dual confidence criterion (Sample Size Reference sheet, signed
 *  off by Dr. Zulfiqar): LOW if below the absolute floor (confidenceMinSample)
 *  OR below the study's own population-based required sample — whichever is
 *  known. `requiredSampleSize` is omitted/null for studies created before
 *  this field existed, in which case only the absolute floor applies. */
export function confidenceFlagOf(input: {
  validResponseCount: number;
  dontKnowRate: number;
  thresholds: Thresholds;
  requiredSampleSize?: number | null;
}): "LOW" | "STANDARD" {
  const { validResponseCount: n, dontKnowRate, thresholds: t, requiredSampleSize } = input;
  const belowAbsoluteFloor = n < t.confidenceMinSample;
  const belowCoverageTarget = requiredSampleSize != null && n < requiredSampleSize;
  return belowAbsoluteFloor || belowCoverageTarget || dontKnowRate > t.dontKnowLowThreshold ? "LOW" : "STANDARD";
}
