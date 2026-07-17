export type SlaAlertStatus = "pending" | "at_risk" | "breached";

export interface SlaAlert {
  aiDecisionId: string;
  studyId: string;
  studyTitle: string;
  needStatement: string | null;
  touchpoint: string;
  createdAt: string;
  dueAt: string;
  status: SlaAlertStatus;
  // Null = the Study has no assigned reviewer (pre-existing Study created
  // before this field existed, or an org with no NGO Research Officer at
  // Study-creation time) — the frontend shows "Unassigned" for that case.
  // Always reflects the Study's *current* assignedReviewerId, so a future
  // reassignment shows up here automatically with no change needed on this
  // side.
  assignedReviewerId: string | null;
  assignedReviewerName: string | null;
}

export interface SlaConfig {
  slaHours: number;
  pollIntervalMs: number;
}
