import type { GapType, Thresholds } from "../need-record.types";

export interface GapTypeInput {
  severityScore: number | null;
  equityFlag: boolean;
  /** Same indicator, previous cycle. null when no prior rollup is stored. */
  priorCycleSeverity: number | null;
  /** Optional per-indicator override from the question bank. */
  gapTypeHint: GapType | null;
  thresholds: Thresholds;
}

/**
 * gap_type for a SURVEY-derived need. The client's vocabulary is
 * Acute / Structural / Seasonal / Chronic / Inequality.
 *
 * Precedence is deliberate:
 *   hint       — an explicit methodology assignment always wins
 *   inequality — variance across groups is what the spec ties this value to
 *   acute      — CRITICAL-band severity
 *   chronic    — sustained above the chronic floor across two cycles
 *   structural — the residual for a measured need
 *   null       — nothing measured, so nothing to classify
 *
 * `seasonal` is never inferred: it needs a multi-cycle seasonal series, which a
 * single assessment cannot supply. Assigning it from one cycle would be a guess
 * dressed as a classification.
 */
export function deriveGapType(input: GapTypeInput): GapType | null {
  const { severityScore, equityFlag, priorCycleSeverity, gapTypeHint, thresholds: t } = input;

  if (gapTypeHint) return gapTypeHint;
  if (severityScore === null) return null;
  if (equityFlag) return "inequality";
  if (severityScore >= t.acuteSeverityFloor) return "acute";
  if (
    severityScore >= t.chronicSeverityFloor &&
    priorCycleSeverity !== null &&
    priorCycleSeverity >= t.chronicSeverityFloor
  ) {
    return "chronic";
  }
  return "structural";
}

/** Printed in the report so a reader can check the classification rather than
 *  take it on trust — the client's reproducibility objection applies here too. */
export function gapTypeBasis(t: Thresholds): string {
  return (
    `gap_type precedence: methodology hint → inequality (equity flag) → acute (severity ≥ ${t.acuteSeverityFloor}) → ` +
    `chronic (severity ≥ ${t.chronicSeverityFloor} in this AND the prior cycle) → structural → not classified (severity not measured). ` +
    `"Seasonal" is never inferred from a single assessment cycle.`
  );
}
