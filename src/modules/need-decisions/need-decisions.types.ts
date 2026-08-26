export type DecisionStatus = 'open' | 'in_progress' | 'completed' | 'cancelled';

// Q11 — fixed set, in the confirmed lifecycle order. Open -> In Progress
// -> Completed / Cancelled (either terminal state reachable from either
// open state, not a strict linear chain).
export const DECISION_STATUSES: DecisionStatus[] = ['open', 'in_progress', 'completed', 'cancelled'];

export interface NeedDecisionRow {
  id: string;
  needId: string;
  decisionType: string;
  responsibleParty: string;
  status: string;
  decisionDate: Date;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NeedDecisionStatusEventRow {
  id: string;
  decisionId: string;
  fromStatus: string | null;
  toStatus: string;
  changedBy: string;
  changedAt: Date;
  note: string | null;
}

export interface NeedDecisionStatusEvent {
  id: string;
  fromStatus: DecisionStatus | null;
  toStatus: DecisionStatus;
  changedBy: string;
  changedAt: string;
  note: string | null;
}

export interface NeedDecision {
  id: string;
  needId: string;
  decisionType: string;
  responsibleParty: string;
  status: DecisionStatus;
  decisionDate: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  history: NeedDecisionStatusEvent[];
}

export interface CreateNeedDecisionPayload {
  decisionType: string;
  responsibleParty: string;
  decisionDate: string;
  notes?: string;
}

export interface UpdateNeedDecisionStatusPayload {
  status: DecisionStatus;
  note?: string;
}
