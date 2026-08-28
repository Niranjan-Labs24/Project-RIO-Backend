export interface PriorityThresholds {
  criticalSeverity: number;
  highSeverity: number;
  mediumSeverity: number;
  equityHighSeverity: number;
}

export interface PriorityFactorWeight {
  key: string;
  label: string;
  weight: number;
}

export interface ConfidenceFlagSettings {
  dontKnowRatioThreshold: number;
  minRespondentsForStandardConfidence: number;
}

/**
 * RIO-AI-001's configurable low-confidence bands for AI classification
 * suggestions. Both are on AiDecision.confidence's own 0..1 scale — NOT the
 * 0-100 severity scale PriorityThresholds uses.
 *
 * A suggestion at or above `lowConfidenceThreshold` is treated as normal; below
 * it the reviewer UI flags it for closer attention, and below
 * `veryLowConfidenceThreshold` it gets the strongest treatment.
 */
export interface AiClassificationSettings {
  lowConfidenceThreshold: number;
  veryLowConfidenceThreshold: number;
}

/**
 * RIO-AI-003's "above a DEFINED length threshold" rule.
 *
 * `statementLengthThreshold` is a character count on the raw statement, and is
 * language-neutral by client decision (25 Aug 2026): one number for Arabic and
 * English alike. A word count was rejected because Arabic is materially more
 * compact per character, so a single word threshold would behave as two
 * different rules depending on the language.
 *
 * `maxSummaryChars` caps the OUTPUT. Without it, a statement that only just
 * crosses the threshold can come back with a "summary" longer than its source.
 */
export interface AiSummarySettings {
  statementLengthThreshold: number;
  maxSummaryChars: number;
}

/** RIO-FR-003 — how a raw figure becomes the 0-100 value a factor weight
 * multiplies. `priorityFactorWeights` says a factor is worth 12%; this says
 * what "450 affected people" is worth out of 100.
 *
 * Mirrors ScoringLookup's numericFloor/numericCeiling, which already does this
 * for numeric survey questions: at or below the floor scores 0, at or above
 * the ceiling scores 100, linear in between. */
export interface FactorRange {
  floor: number;
  ceiling: number;
}

/** One strategic axis from the workbook's METH — Factors & Multipliers sheet.
 *
 * `domains` is the default link. `questionIds` are the exceptions the workbook
 * names individually — KPIs that belong to this axis even though they sit in
 * another domain — and they win over the domain match. */
export interface StrategicAxis {
  key: string;
  label: string;
  /** 0-100, normalised from the workbook's multiplier over its own x1.30
   *  ceiling. See the migration for the derivation. */
  value: number;
  domains: string[];
  questionIds: string[];
}

export interface PriorityFactorScales {
  /** Urgency is a human-chosen level, so it maps by name rather than by range. */
  urgency: Record<string, number>;
  affectedPopulation: FactorRange;
  geographicCoverage: FactorRange;
  /** How many other needs share a theme with this one. */
  frequency: FactorRange;
  strategicAxes: StrategicAxis[];
  /** RIO-FR-003 — how wide a spread between respondent segments counts as
   *  inequity, on the same 0-100 scale as the spread itself. The methodology
   *  says results must differ "materially" between sex / age / disability but
   *  never gives a number, so this is the methodology owner's to set rather
   *  than ours to invent. */
  equitySpreadThreshold: number;
}

export type MethodologyStatus = "draft" | "pending_approval" | "approved" | "published";

export interface MethodologyConfigRow {
  id: string;
  version: string;
  status: MethodologyStatus;
  publishedBy: string | null;
  publishedAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  priorityThresholds: unknown;
  priorityFactorWeights: unknown;
  confidenceFlagSettings: unknown;
  aiClassificationSettings: unknown;
  aiSummarySettings: unknown;
  priorityFactorScales: unknown;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface MethodologyConfig {
  id: string;
  version: string;
  status: MethodologyStatus;
  publishedByName: string | null;
  publishedAt: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  priorityThresholds: PriorityThresholds;
  priorityFactorWeights: PriorityFactorWeight[];
  confidenceFlagSettings: ConfidenceFlagSettings;
  aiClassificationSettings: AiClassificationSettings;
  aiSummarySettings: AiSummarySettings;
  priorityFactorScales: PriorityFactorScales;
  updatedAt: string;
  updatedByName: string | null;
}

// RIO-NFR-017 — one immutable snapshot per edit/publish (see
// MethodologyConfigHistory's schema comment).
export interface MethodologyConfigHistoryEntry {
  id: string;
  version: string;
  status: MethodologyStatus;
  changeType: "edit" | "approve" | "reject" | "publish";
  priorityThresholds: PriorityThresholds;
  priorityFactorWeights: PriorityFactorWeight[];
  confidenceFlagSettings: ConfidenceFlagSettings;
  aiClassificationSettings: AiClassificationSettings;
  aiSummarySettings: AiSummarySettings;
  priorityFactorScales: PriorityFactorScales;
  changedByName: string | null;
  changedAt: string;
}

export interface UpdateMethodologyConfigPayload {
  version?: string;
  priorityThresholds?: Partial<PriorityThresholds>;
  priorityFactorWeights?: Array<{ key: string; weight: number }>;
  confidenceFlagSettings?: Partial<ConfidenceFlagSettings>;
  aiClassificationSettings?: Partial<AiClassificationSettings>;
  aiSummarySettings?: Partial<AiSummarySettings>;
  priorityFactorScales?: Partial<PriorityFactorScales>;
}

// The Survey Builder's "Methodology Version" dropdown option shape — sourced
// from the single MethodologyConfig row's id/version now (see
// MethodologyConfigService.listVersionOptions), not the old, disconnected
// MethodologyVersionOption Prisma model.
//
// `name` added alongside `version` so this dropdown can show the same
// human-readable label ("Village Needs Methodology v5.0 - ...") the New
// Study screen already shows for the identical published MethodologyVersion
// row — previously this screen showed the bare `version` field instead,
// which read as a different methodology even though it was the same one.
// `version` stays the field actually persisted onto Survey.methodologyVersion
// (unchanged), `name` is display-only.
export interface MethodologyVersionOption {
  id: string;
  version: string;
  name: string;
}
