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

export type MethodologyStatus = "draft" | "published";

export interface MethodologyConfigRow {
  id: string;
  version: string;
  status: MethodologyStatus;
  publishedBy: string | null;
  publishedAt: Date | null;
  priorityThresholds: unknown;
  priorityFactorWeights: unknown;
  confidenceFlagSettings: unknown;
  aiClassificationSettings: unknown;
  aiSummarySettings: unknown;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface MethodologyConfig {
  id: string;
  version: string;
  status: MethodologyStatus;
  publishedByName: string | null;
  publishedAt: string | null;
  priorityThresholds: PriorityThresholds;
  priorityFactorWeights: PriorityFactorWeight[];
  confidenceFlagSettings: ConfidenceFlagSettings;
  aiClassificationSettings: AiClassificationSettings;
  aiSummarySettings: AiSummarySettings;
  updatedAt: string;
  updatedByName: string | null;
}

// RIO-NFR-017 — one immutable snapshot per edit/publish (see
// MethodologyConfigHistory's schema comment).
export interface MethodologyConfigHistoryEntry {
  id: string;
  version: string;
  status: MethodologyStatus;
  changeType: "edit" | "publish";
  priorityThresholds: PriorityThresholds;
  priorityFactorWeights: PriorityFactorWeight[];
  confidenceFlagSettings: ConfidenceFlagSettings;
  aiClassificationSettings: AiClassificationSettings;
  aiSummarySettings: AiSummarySettings;
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
}

// The Survey Builder's "Methodology Version" dropdown option shape — sourced
// from the single MethodologyConfig row's id/version now (see
// MethodologyConfigService.listVersionOptions), not the old, disconnected
// MethodologyVersionOption Prisma model.
export interface MethodologyVersionOption {
  id: string;
  version: string;
}
