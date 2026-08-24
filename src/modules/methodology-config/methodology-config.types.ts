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
  updatedAt: string;
  updatedByName: string | null;
}

export interface UpdateMethodologyConfigPayload {
  version?: string;
  priorityThresholds?: Partial<PriorityThresholds>;
  priorityFactorWeights?: Array<{ key: string; weight: number }>;
  confidenceFlagSettings?: Partial<ConfidenceFlagSettings>;
  aiClassificationSettings?: Partial<AiClassificationSettings>;
}

// The Survey Builder's "Methodology Version" dropdown option shape — sourced
// from the single MethodologyConfig row's id/version now (see
// MethodologyConfigService.listVersionOptions), not the old, disconnected
// MethodologyVersionOption Prisma model.
export interface MethodologyVersionOption {
  id: string;
  version: string;
}
