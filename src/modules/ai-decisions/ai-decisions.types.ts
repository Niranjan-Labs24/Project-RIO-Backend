export type AiTouchpoint = 'need_classification' | 'priority_scoring';

export interface AiDecisionRow {
  id: string;
  orgId: string;
  studyId: string;
  touchpoint: AiTouchpoint;
  subjectType: string;
  subjectId: string;
  modelName: string;
  modelVersion: string;
  suggestion: unknown;
  confidence: number;
  humanDecision: unknown;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface AiDecision {
  id: string;
  studyId: string;
  touchpoint: AiTouchpoint;
  subjectType: string;
  subjectId: string;
  modelName: string;
  modelVersion: string;
  suggestion: unknown;
  confidence: number;
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
