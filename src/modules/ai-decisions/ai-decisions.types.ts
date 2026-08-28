import type { ConfidenceBand } from './confidence-band';

export type AiTouchpoint = 'need_classification' | 'priority_scoring';

export interface AiDecisionRow {
  id: string;
  orgId: string;
  needId: string;
  studyId: string;
  touchpoint: AiTouchpoint;
  subjectType: string;
  subjectId: string;
  modelName: string;
  modelVersion: string;
  suggestion: unknown;
  confidence: number | null;
  humanDecision: unknown;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface AiDecision {
  id: string;
  needId: string;
  studyId: string;
  touchpoint: AiTouchpoint;
  subjectType: string;
  subjectId: string;
  modelName: string;
  modelVersion: string;
  suggestion: unknown;
  /** 0..1, or `null` when the model reported none — see AiDecision.confidence
   * in schema.prisma. Consumers must distinguish `null` ("not reported") from
   * `0` ("AI declined to classify"); rendering both as 0% is a bug. */
  confidence: number | null;
  /** RIO-AI-001. Resolved server-side from the configured thresholds so the
   * reviewer UI never re-derives (and never re-hardcodes) them. */
  confidenceBand: ConfidenceBand;
  /** The thresholds this band was resolved against, echoed so the UI can say
   * "below 70%" without a second round trip to the methodology config. */
  confidenceThresholds: { low: number; veryLow: number };
  humanDecision: unknown;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface ReviewDecisionPayload {
  decision: 'approved' | 'rejected' | 'modified';
  notes?: string;
  overrideValue?: unknown;
}

export interface ScoringStubResponse {
  status: 'pending';
  message: string;
}
