// The single place any 0–100 score becomes a band, and the single place a
// confidence rating is turned into a sentence.
//
// Three files previously inlined their own thresholds (report-summary.service,
// snapshot-to-content, priority-v2) which is how the same figure could render
// as HIGH in a table and MEDIUM in a narrative on the same page.

import { DEFAULT_THRESHOLDS, type SeverityBand, type Thresholds } from "../need-record.types";

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
  "Priority Score is performance-based: LOWER means more urgent. It is the inverse of the Severity scores on this page, where higher means worse.";

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
}): string {
  const { validResponseCount: n, dontKnowRate, thresholds: t, requiredSampleSize } = input;
  const reasons: string[] = [];
  let sampleReasonFired = false;

  if (n < t.confidenceMinSample) {
    reasons.push(
      `Small sample: ${n} valid response(s), below the ${t.confidenceMinSample} required for STANDARD confidence.`,
    );
    sampleReasonFired = true;
  } else if (requiredSampleSize != null && n < requiredSampleSize) {
    // RIO-FR-024 dual confidence criterion: below the absolute floor above,
    // OR below the study's own population-based required sample — checked
    // as `else if` since both conditions describe the same "too few
    // responses" fact and would otherwise duplicate the reason.
    reasons.push(
      `Below coverage target: ${n} valid response(s), below the ${requiredSampleSize} required for this study's population at the configured confidence level and margin of error.`,
    );
    sampleReasonFired = true;
  }
  if (dontKnowRate > t.dontKnowLowThreshold) {
    reasons.push(
      `Elevated don't-know rate: ${(dontKnowRate * 100).toFixed(2)}% exceeds the ${(t.dontKnowLowThreshold * 100).toFixed(0)}% threshold.`,
    );
  }

  if (reasons.length === 0) return "High response completeness.";

  // When only the sample-size condition fired, say so — and say the DK rate did NOT contribute.
  if (reasons.length === 1 && sampleReasonFired) {
    reasons.push(
      `The don't-know rate of ${(dontKnowRate * 100).toFixed(2)}% is ${dontKnowBandOf(dontKnowRate)} and did not contribute to this rating.`,
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
