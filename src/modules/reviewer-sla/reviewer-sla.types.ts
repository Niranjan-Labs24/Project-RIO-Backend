export type SlaAlertStatus = "pending" | "at_risk" | "breached";

// Three queues share this same alert shape, but only one caller ever sees
// any given request's response — see ReviewerSlaService.listAlerts, which
// branches on the caller's own role:
//  - survey_approval: a Survey sitting in SUBMITTED awaiting the
//    Approver's Approve/Reject — org-wide, shown to whoever holds
//    surveyBuilder:approve (human_reviewer, ngo_admin).
//  - survey_approved / survey_rejected: a Survey the CALLER themselves
//    created (Survey.createdBy) that just reached PUBLISHED/REJECTED —
//    shown only to the Research Officer who submitted it (surveyBuilder:write
//    without :approve). Nothing here is actually racing an SLA clock (the
//    item is already resolved), so `dueAt` is just the resolution timestamp
//    and `status` is always "pending" (meaning "unread", not "at risk").
// `id` is whichever underlying row this alert is about (AiDecision.id or
// Survey.id); `surveyId` is set for both survey_* types, since that's what
// the Survey Builder page's link needs. `comments` is only ever set for
// survey_rejected (the Approver's rejection reason).
export type SlaAlertType = "ai_classification" | "survey_approval" | "survey_approved" | "survey_rejected";

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
  comments?: string | null;
}

export interface SlaConfig {
  slaHours: number;
  pollIntervalMs: number;
}
