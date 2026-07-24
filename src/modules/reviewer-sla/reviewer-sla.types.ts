export type SlaAlertStatus = "pending" | "at_risk" | "breached";

// Two different queues share this same alert shape: an AiDecision awaiting
// classification review (ai_classification), and a Survey sitting in
// SUBMITTED awaiting Approve/Reject (survey_approval) — see
// ReviewerSlaService.listAlerts. `id` is whichever underlying row this
// alert is about (AiDecision.id or Survey.id); `surveyId` is set only for
// survey_approval alerts, since that's what the Review page's link needs.
export type SlaAlertType = "ai_classification" | "survey_approval";

export interface SlaAlert {
  id: string;
  type: SlaAlertType;
  needId: string;
  studyId: string;
  surveyId: string | null;
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
