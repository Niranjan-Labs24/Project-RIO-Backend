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
}

export interface SlaConfig {
  slaHours: number;
  pollIntervalMs: number;
}
