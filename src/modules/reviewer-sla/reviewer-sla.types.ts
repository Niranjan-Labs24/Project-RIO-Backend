export type SlaAlertStatus = "pending" | "at_risk" | "breached";

// Several queues share this same alert shape, but only one caller ever sees
// any given request's response — see ReviewerSlaService.listAlerts, which
// branches on the caller's own role/permissions:
//  - survey_approval: a Survey sitting in SUBMITTED awaiting the
//    Approver's Approve/Reject — org-wide, shown to whoever holds
//    surveyBuilder:approve (human_reviewer, ngo_admin).
//  - survey_ready_to_publish / survey_rejected: a Survey the CALLER
//    themselves created (Survey.createdBy) that just reached APPROVED/
//    REJECTED — shown only to the Research Officer who submitted it
//    (surveyBuilder:write without :approve). Client-confirmed (Aug 13
//    call): approval no longer auto-publishes, so "approved" now means
//    "go publish it yourself" rather than "it's already live" — see
//    SurveysService.approveSurvey/publishSurvey. Nothing here is actually
//    racing an SLA clock (the item is already resolved/actionable-by-you),
//    so `dueAt` is just the resolution timestamp and `status` is always
//    "pending" (meaning "unread", not "at risk").
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
//  - evidence_document_uploaded: an EvidenceDocument linked to a Need
//    (linkedNeedId set) with no EvidenceDocumentSummary yet — shown to
//    whoever holds priorityScoring:create (data_analyst only; this is the
//    precise gate EvidenceDocumentsController.generateSummary itself checks
//    — see role-matrix.ts). Auto-resolves the same way every other queue
//    here does: once a summary exists for the document, the next poll's
//    query simply stops returning it — no explicit dismiss. No configured
//    SLA clock for this either, so `status` is always "pending".
// `id` is whichever underlying row this alert is about (AiDecision.id,
// Survey.id, Report.id, or EvidenceDocument.id). `needId`/`studyId`/
// `surveyId` are set for the survey_* types (a Report may be org-wide, with
// no Study at all — see Report.studyId's own nullable comment — so these are
// all nullable); `reportId` is set for the report_* types instead, and
// `studyTitle` doubles as "the link text" — the Study's title for survey and
// evidence_document_uploaded alerts, the Report's own title for report
// alerts (not a real Study title in that case). `comments` is only ever set
// for survey_rejected (the Approver's rejection reason) — report rejection
// has no reason field today.
export type SlaAlertType =
  | "ai_classification"
  | "survey_approval" | "survey_ready_to_publish" | "survey_rejected"
  | "report_approval" | "report_released" | "report_rejected"
  | "evidence_document_uploaded";

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
