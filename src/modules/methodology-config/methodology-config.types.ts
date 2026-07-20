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
  updatedAt: string;
  updatedByName: string | null;
}

export interface UpdateMethodologyConfigPayload {
  version?: string;
  priorityThresholds?: Partial<PriorityThresholds>;
  priorityFactorWeights?: Array<{ key: string; weight: number }>;
  confidenceFlagSettings?: Partial<ConfidenceFlagSettings>;
}
