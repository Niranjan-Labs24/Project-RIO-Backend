export interface PriorityFactor {
  key: string;
  label: string;
  value: number;
  weight: number;
}

export interface PriorityScoreResult {
  overallScore: number;
  level: "critical" | "high" | "medium" | "low";
  gapType: "acute" | "chronic" | "structural" | "seasonal" | "inequality-linked";
  factors: PriorityFactor[];
  cycleNote: string | null;
}

export interface PriorityFactorWeight {
  key: string;
  label: string;
  weight: number;
}

export interface PriorityThresholds {
  criticalSeverity: number;
  highSeverity: number;
  mediumSeverity: number;
  equityHighSeverity: number;
}

function levelFor(severity: number, hasEquityFlag: boolean, thresholds: PriorityThresholds): PriorityScoreResult["level"] {
  if (severity >= thresholds.highSeverity || (severity >= thresholds.equityHighSeverity && hasEquityFlag)) return "high";
  if (severity >= thresholds.mediumSeverity) return "medium";
  return "low";
}

// TODO(RIO-Priority): placeholder scoring only — does not implement the
// real methodology scoring workbook. Exists so Reports/Archive/Sharing have
// real rows to consume; swapping in the real engine later only touches
// this function, never its callers. Deterministic (seeded by responseCount
// and completenessAvg) rather than random, so repeated calls against the
// same inputs are stable/explainable, per scope.md's "explainable, auditable"
// requirement. `thresholds`/`factorWeights` come from the Methodology
// Configuration screen (MethodologyConfigService), never hardcoded here —
// that's the whole point of both being editable in that screen.
export function scorePriority(input: {
  responseCount: number;
  averageCompleteness: number;
  domainCode: string | null;
  thresholds: PriorityThresholds;
  factorWeights: PriorityFactorWeight[];
}): PriorityScoreResult {
  const { thresholds } = input;
  const severity = Math.min(100, 40 + input.responseCount * 5);
  const hasEquityFlag = input.averageCompleteness < 70;
  const level = levelFor(severity, hasEquityFlag, thresholds);

  const factors: PriorityFactor[] = input.factorWeights.map((def) => ({
    ...def,
    value: def.key === "severity" ? severity : def.key === "data_confidence" ? input.averageCompleteness : 50,
  }));
  const overallScore = Math.round(
    factors.reduce((sum, factor) => sum + factor.value * factor.weight, 0),
  );

  const isHealthOrWater = input.domainCode === "H" || input.domainCode === "W";
  const finalLevel: PriorityScoreResult["level"] =
    severity >= thresholds.criticalSeverity && isHealthOrWater ? "critical" : level;

  return {
    overallScore,
    level: finalLevel,
    gapType: "acute",
    factors,
    cycleNote: finalLevel === "critical" || finalLevel === "high" ? "Acute — Cycle 1, awaiting trend" : null,
  };
}
