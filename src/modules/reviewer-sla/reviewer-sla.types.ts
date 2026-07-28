export type SlaAlertStatus = "pending" | "at_risk" | "breached";

// Several queues share this same alert shape, but only one caller ever sees
// any given request's response — see ReviewerSlaService.listAlerts, which
// branches on the caller's own role/permissions:
//  - survey_approval: a Survey sitting in SUBMITTED awaiting the
//    Approver's Approve/Reject — org-wide, shown to whoever holds
//    surveyBuilder:approve (human_reviewer, ngo_admin).
//  - survey_approved / survey_rejected: a Survey the CALLER themselves
//    created (Survey.createdBy) that just reached PUBLISHED/REJECTED —
//    shown only to the Research Officer who submitted it (surveyBuilder:write
//    without :approve). Nothing here is actually racing an SLA clock (the
//    item is already resolved), so `dueAt` is just the resolution timestamp
//    and `status` is always "pending" (meaning "unread", not "at risk").
//  - report_approval: a Report the Research Officer has confirmed
//    (officerConfirmedAt set) but that's still `draft`, awaiting the
//    Approver's Approve/Reject — org-wide, shown to whoever holds
//    reportsDashboards:approve (human_reviewer, ngo_admin). Reports have no
//    configured SLA clock (unlike Surveys), so `status` is always "pending"
//    here too — this is a plain "needs your attention" notification, not a
//    breach-timed one.
//  - report_released / report_rejected: a Report the CALLER themselves
//    generated (Report.generatedBy) that just reached released/rejected —
//    shown only to the Research Officer who generated (and confirmed) it
//    (reportsDashboards:write without :approve).
// `id` is whichever underlying row this alert is about (AiDecision.id,
// Survey.id, or Report.id). `needId`/`studyId`/`surveyId` are set for the
// survey_* types (a Report may be org-wide, with no Study at all — see
// Report.studyId's own nullable comment — so these are all nullable);
// `reportId` is set for the report_* types instead, and `studyTitle` doubles
// as "the link text" — the Study's title for survey alerts, the Report's own
// title for report alerts (not a real Study title in that case). `comments`
// is only ever set for survey_rejected (the Approver's rejection reason) —
// report rejection has no reason field today.
export type SlaAlertType =
  | "ai_classification"
  | "survey_approval" | "survey_approved" | "survey_rejected"
  | "report_approval" | "report_released" | "report_rejected";

export interface SlaAlert {
  id: string;
  type: SlaAlertType;
  needId: string | null;
  studyId: string | null;
  surveyId: string | null;
  reportId: string | null;
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
