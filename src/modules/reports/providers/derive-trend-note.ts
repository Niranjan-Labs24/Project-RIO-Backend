// Replaces SINGLE_CYCLE_TREND_NOTE as a blanket default.
//
// The constant asserted "Trends cannot be assessed from a single assessment
// cycle" on every domain of every report — including a Cycle 2 report, which
// then contradicted its own header. The cycle number is in the snapshot; there
// is no reason to guess.

export function deriveTrendNote(input: {
  assessmentCycle: number;
  currentSeverity: number | null;
  priorCycleSeverity: number | null;
  /** "this domain" | "this survey" | an indicator name. */
  scopeLabel: string;
}): string {
  const { assessmentCycle, currentSeverity, priorCycleSeverity, scopeLabel } = input;

  if (assessmentCycle <= 1) {
    return `Cycle 1 baseline — no prior cycle exists to compare ${scopeLabel} against.`;
  }
  if (priorCycleSeverity === null || currentSeverity === null) {
    return `Cycle ${assessmentCycle} assessment. No Cycle ${assessmentCycle - 1} rollup is stored for ${scopeLabel}, so no cycle-over-cycle comparison is available.`;
  }
  const delta = currentSeverity - priorCycleSeverity;
  if (Math.abs(delta) < 0.5) {
    return `Severity ${currentSeverity.toFixed(2)} in Cycle ${assessmentCycle}, unchanged from Cycle ${assessmentCycle - 1}.`;
  }
  const direction = delta < 0 ? "improved" : "worsened";
  return `Severity ${currentSeverity.toFixed(2)} in Cycle ${assessmentCycle} vs ${priorCycleSeverity.toFixed(2)} in Cycle ${assessmentCycle - 1} — ${direction} by ${Math.abs(delta).toFixed(2)} points.`;
}
