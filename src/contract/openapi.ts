import type { INestApplication } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as swaggerUi from 'swagger-ui-express';
import { getRegisteredSchemas } from './typebox';

type Tag =
  | 'Auth'
  | 'Consent'
  | 'Users'
  | 'Organizations'
  | 'Roles'
  | 'Studies'
  | 'Needs'
  | 'Evidence'
  | 'AI Decisions'
  | 'Priority'
  | 'Surveys'
  | 'Priority Summary'
  | 'Audit'
  | 'System Logs'
  | 'Health';

interface RouteDoc {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  tag: Tag;
  summary: string;
  /** `undefined` = public (no session required). `'session'` = any signed-in
   * user (enforced by requireActor() inside the service, not a route
   * decorator). Otherwise the exact `@RequirePermission(module, action)` on
   * the route. */
  auth: undefined | 'session' | { module: string; action: string };
  requestSchema?: string;
  query?: string[];
  response: string;
  /**
   * Name of a schema registered via registerSchema() (GAP-08 Phase 0) that
   * describes this route's 200 response body. `response` above stays as
   * the human-readable description (unchanged) — `responseSchema` adds a
   * machine-readable `content.application/json.schema.$ref` alongside it.
   * Optional and additive: routes without it render byte-identically to
   * before this field existed.
   *
   * Convention (pick one, used consistently across the whole file):
   *  - Single object (e.g. `response: 'Study'`): set
   *    `responseSchema: 'Study'` only.
   *  - Bare array (e.g. `response: 'Evidence[]'`): register the *item*
   *    schema (e.g. 'Evidence') and set `responseSchema: 'Evidence'` +
   *    `responseIsArray: true` — buildOperation() wraps it as
   *    `{ type: 'array', items: { $ref } }`. Do NOT register a separate
   *    "EvidenceList" wrapper schema for this case.
   *  - Paginated envelope (e.g. `{ items: Study[], total, limit, offset }`,
   *    doc'd as `response: 'StudyListResult (...)'`): register ONE schema
   *    for the whole envelope object (e.g. 'StudyListResult', itself
   *    containing `items: Study[]` inline via T.Array(T.Ref('Study'))) and
   *    set `responseSchema` to that envelope schema's name, with
   *    `responseIsArray` left unset — the envelope IS the 200 body, not an
   *    array itself.
   */
  responseSchema?: string;
  /** See responseSchema doc above — set true only for the bare-array case. */
  responseIsArray?: boolean;
}

// One entry per tag, in the order they should appear in Swagger UI's
// sidebar — otherwise it falls back to alphabetical, which buries Auth.
const TAGS: Array<{ name: Tag; description: string }> = [
  { name: 'Auth', description: 'Signup, login, session, and password/consent for the calling user.' },
  { name: 'Consent', description: 'The active data-sharing consent policy shown before signup.' },
  { name: 'Studies', description: 'RIO-FR-001 — the container for a captured community need.' },
  { name: 'Needs', description: 'RIO-FR-001 — the one need captured per study.' },
  { name: 'Evidence', description: 'RIO-FR-Add-01 — supporting documents uploaded against a study.' },
  { name: 'AI Decisions', description: 'RIO-FR-003 — classification/scoring placeholders and human review.' },
  { name: 'Surveys', description: 'Survey Builder — question set, methodology version, approval, and citizen submission.' },
  { name: 'Priority', description: 'Deterministic severity scoring, dashboards, and methodology-version/lookup management.' },
  { name: 'Priority Summary', description: 'Priority summary drafting/approval workflow feeding the Reports module.' },
  { name: 'Users', description: "Manage the caller's own organisation's members." },
  { name: 'Organizations', description: "The caller's own organisation profile, plus cross-entity org listing." },
  { name: 'Roles', description: 'The fixed 9-role permission matrix.' },
  { name: 'Audit', description: 'Immutable audit log of every write across the app.' },
  { name: 'System Logs', description: 'RIO-NFR-016 — operational events and errors (read-only, System Admin).' },
  { name: 'Health', description: 'Liveness/readiness probes.' },
];

// Hand-maintained to mirror each controller exactly — small enough that
// duplicating routes here (rather than reflecting Nest's route metadata at
// runtime) stays easy to keep in sync. When you add or change a route in a
// *.controller.ts file, add/update its entry here too.
//
// NOTE: this file documents a curated subset of the API, not every
// controller — e.g. public-surveys, sharing, report-sharing, response-
// quality, studies-evidence-adjacent routes, and several others exist in
// src/modules/** with no entry here at all. The Surveys/Priority/Priority
// Summary tags below were added specifically to cover the routes given new
// TypeBox/AJV request-body validation in the backend remediation pass
// (2026-07-27) — not a full sweep of the whole controller surface, which
// would be a materially larger, separate documentation task.
const ROUTES: RouteDoc[] = [
  {
    method: 'post', path: '/auth/login', tag: 'Auth', summary: 'Sign in with email + password',
    auth: undefined, requestSchema: 'LoginBody', response: 'SessionContext',
    responseSchema: 'SessionContext',
  },
  {
    method: 'post', path: '/auth/signup', tag: 'Auth', summary: 'Public NGO signup — creates the organisation + its first NGO Admin',
    auth: undefined, requestSchema: 'SignupBody', response: 'SignupPendingApprovalView (status: pending_approval — no session issued, requires Center approval first)',
    responseSchema: 'SignupPendingApprovalView',
  },
  {
    method: 'get', path: '/auth/me', tag: 'Auth', summary: "Re-fetch the caller's current session",
    auth: 'session', response: 'SessionContext',
    responseSchema: 'SessionContext',
  },
  {
    method: 'post', path: '/auth/logout', tag: 'Auth', summary: 'Sign out (clears the session/CSRF cookies)',
    auth: 'session', response: '204 No Content',
  },
  {
    method: 'post', path: '/auth/consent', tag: 'Auth', summary: 'Record the consent-policy acceptance for the current user',
    auth: 'session', requestSchema: 'ConsentBody', response: '{ consentedAt, policyVersion }',
  },
  {
    method: 'post', path: '/auth/change-password', tag: 'Auth', summary: "Replace the caller's own password",
    auth: 'session', requestSchema: 'ChangePasswordBody', response: 'SessionContext',
    responseSchema: 'SessionContext',
  },
  {
    // NOTE (discrepancy, flagged in auth.contract.ts): the real response is
    // ActiveConsentPolicies ({ usePolicy, dataSharing }), confirmed against
    // ConsentController#getActive and the frontend's consentService — not
    // the singular ActiveConsentPolicy this route's `response` text
    // originally named. Wired to the wrapper schema per the FE/actual-BE
    // shape.
    method: 'get', path: '/consent-policy/active', tag: 'Consent', summary: 'The currently active consent policies (version + English and Arabic text)',
    auth: undefined, response: 'ActiveConsentPolicies ({ usePolicy: ActiveConsentPolicy, dataSharing: ActiveConsentPolicy })',
    responseSchema: 'ActiveConsentPolicies',
  },
  {
    method: 'post', path: '/studies', tag: 'Studies', summary: 'Create a study',
    auth: { module: 'studySurvey', action: 'create' }, requestSchema: 'CreateStudyBody', response: 'Study',
    responseSchema: 'Study',
  },
  {
    method: 'get', path: '/studies', tag: 'Studies', summary: "List the caller's organisation's studies",
    auth: { module: 'studySurvey', action: 'read' }, query: ['limit', 'offset', 'status', 'search'],
    response: 'StudyListResult ({ items: Study[], total, limit, offset })',
    responseSchema: 'StudyListResult',
  },
  {
    method: 'get', path: '/studies/{id}', tag: 'Studies', summary: 'Get a single study',
    auth: { module: 'studySurvey', action: 'read' }, response: 'StudyDetail (Study + evidenceCount)',
    responseSchema: 'StudyDetail',
  },
  {
    method: 'patch', path: '/studies/{id}', tag: 'Studies', summary: "Rename a study (title is the only editable Study-level field)",
    auth: { module: 'studySurvey', action: 'write' }, requestSchema: 'UpdateStudyBody', response: 'Study',
    responseSchema: 'Study',
  },
  {
    method: 'delete', path: '/studies/{id}', tag: 'Studies', summary: 'Delete a study — allowed only up to evidence_submitted; blocked once ai_classified/human_reviewed',
    auth: { module: 'studySurvey', action: 'write' }, response: '204 No Content',
  },
  {
    method: 'post', path: '/studies/{studyId}/need', tag: 'Needs', summary: 'Capture the need for a study (one per study)',
    auth: { module: 'dataCollection', action: 'create' }, requestSchema: 'CreateNeedBody', response: 'Need',
    responseSchema: 'Need',
  },
  {
    method: 'get', path: '/studies/{studyId}/need', tag: 'Needs', summary: "Get a study's captured need",
    auth: { module: 'dataCollection', action: 'read' }, response: 'Need',
    responseSchema: 'Need',
  },
  {
    method: 'patch', path: '/studies/{studyId}/need', tag: 'Needs', summary: "Edit a study's captured need",
    auth: { module: 'dataCollection', action: 'write' }, requestSchema: 'UpdateNeedBody', response: 'Need',
    responseSchema: 'Need',
  },
  {
    method: 'post', path: '/studies/{studyId}/evidence', tag: 'Evidence', summary: 'Upload one or more evidence files (multipart/form-data, field name "files"; max 10MB/file, 10 files/study)',
    auth: { module: 'dataCollection', action: 'create' }, response: 'Evidence[]',
    responseSchema: 'Evidence', responseIsArray: true,
  },
  {
    method: 'get', path: '/studies/{studyId}/evidence', tag: 'Evidence', summary: "List a study's uploaded evidence",
    auth: { module: 'dataCollection', action: 'read' }, response: 'Evidence[]',
    responseSchema: 'Evidence', responseIsArray: true,
  },
  {
    method: 'post', path: '/studies/{studyId}/evidence/submit', tag: 'Evidence', summary: 'Submit uploaded evidence — required before AI Classification is allowed to run',
    auth: { module: 'dataCollection', action: 'write' }, response: '200 OK',
  },
  {
    method: 'delete', path: '/evidence/{id}', tag: 'Evidence', summary: 'Delete an uploaded evidence file',
    auth: { module: 'dataCollection', action: 'write' }, response: '204 No Content',
  },
  {
    method: 'post', path: '/studies/{studyId}/ai-decisions/classify', tag: 'AI Decisions', summary: 'Run the (placeholder) need classification and store the AI suggestion (domains[]/subDomains[] — one Need, possibly several suggested domains). Requires evidence to have been submitted first.',
    auth: { module: 'aiReview', action: 'write' }, response: 'AiDecision',
    responseSchema: 'AiDecision',
  },
  {
    method: 'get', path: '/studies/{studyId}/ai-decisions', tag: 'AI Decisions', summary: "List a study's AI decisions",
    auth: { module: 'aiReview', action: 'read' }, response: 'AiDecision[]',
    responseSchema: 'AiDecision', responseIsArray: true,
  },
  {
    method: 'post', path: '/studies/{studyId}/ai-decisions/score', tag: 'AI Decisions', summary: 'Priority scoring stub — no DB write; scoring engine lands once methodology is approved',
    auth: { module: 'priorityScoring', action: 'create' }, response: '{ status: "pending", message: string }',
  },
  {
    method: 'patch', path: '/ai-decisions/{id}/review', tag: 'AI Decisions', summary: "Record a human reviewer's decision over an AI suggestion",
    auth: { module: 'aiReview', action: 'approve' }, requestSchema: 'ReviewDecisionBody', response: 'AiDecision',
    responseSchema: 'AiDecision',
  },
  {
    method: 'get', path: '/users', tag: 'Users', summary: "List the caller's own organisation's users, or (cross-entity) another org's via ?organizationId",
    auth: { module: 'entityTeam', action: 'read' }, query: ['organizationId', 'limit', 'offset'], response: 'OrgUser[]',
    responseSchema: 'OrgUser', responseIsArray: true,
  },
  {
    method: 'post', path: '/users', tag: 'Users', summary: 'Invite a user into the caller\'s own organisation',
    auth: { module: 'entityTeam', action: 'create' }, requestSchema: 'InviteUserBody',
    response: 'InviteUserResponse (OrgUser + temporaryPasswordEmailed, temporaryPassword?)',
    responseSchema: 'InviteUserResponse',
  },
  {
    method: 'patch', path: '/users/{id}', tag: 'Users', summary: "Update a user in the caller's own organisation",
    auth: { module: 'entityTeam', action: 'write' }, requestSchema: 'UpdateUserBody', response: 'OrgUser',
    responseSchema: 'OrgUser',
  },
  {
    method: 'delete', path: '/users/{id}', tag: 'Users', summary: "Remove a user from the caller's own organisation",
    auth: { module: 'entityTeam', action: 'write' }, response: '204 No Content',
  },
  {
    method: 'get', path: '/organizations/current', tag: 'Organizations', summary: "The caller's own organisation profile",
    auth: { module: 'entityTeam', action: 'read' }, response: 'Organization',
    responseSchema: 'Organization',
  },
  {
    method: 'patch', path: '/organizations/current', tag: 'Organizations', summary: "Update the caller's own organisation profile",
    auth: { module: 'entityTeam', action: 'write' }, requestSchema: 'UpdateOrganizationBody', response: 'Organization',
    responseSchema: 'Organization',
  },
  {
    method: 'get', path: '/organizations', tag: 'Organizations', summary: 'Cross-entity — every organisation on the platform',
    auth: { module: 'entityTeam', action: 'read' }, query: ['limit', 'offset'], response: 'OrganizationSummary[]',
    responseSchema: 'OrganizationSummary', responseIsArray: true,
  },
  {
    method: 'get', path: '/organizations/{id}', tag: 'Organizations', summary: "Cross-entity — another organisation's profile",
    auth: { module: 'entityTeam', action: 'read' }, response: 'OrganizationSummary',
    responseSchema: 'OrganizationSummary',
  },
  {
    method: 'post', path: '/organizations', tag: 'Organizations', summary: 'Create a new organisation + its first NGO Admin',
    auth: { module: 'entityTeam', action: 'create' }, requestSchema: 'CreateOrganizationBody', response: 'Organization',
    responseSchema: 'Organization',
  },
  {
    method: 'get', path: '/roles', tag: 'Roles', summary: 'List the fixed 9-role permission matrix',
    auth: { module: 'rolesPermissions', action: 'read' }, response: 'RoleDef[]',
    responseSchema: 'RoleDef', responseIsArray: true,
  },
  {
    method: 'get', path: '/audit', tag: 'Audit', summary: 'Immutable audit log — own organisation, or (cross-entity) any organisation via ?organizationId',
    auth: { module: 'auditLog', action: 'read' },
    query: ['organizationId', 'entityType', 'entityId', 'actorId', 'action', 'dateFrom', 'dateTo', 'search', 'limit', 'offset'],
    response: 'AuditListResult ({ items: AuditEvent[], total, limit, offset })',
    responseSchema: 'AuditListResult',
  },
  // System Logs (RIO-NFR-016) — operational telemetry, read-only. Distinct
  // from /audit above: that is the business-event governance trail
  // (RIO-FR-007); these are system errors, failed integrations, slow
  // requests and job outcomes, gated on the System-Admin-only `systemLogs`
  // module. No write/delete route exists — rows are written in-process and
  // removed only by the retention job.
  {
    method: 'get', path: '/system-logs', tag: 'System Logs', summary: 'Operational events and errors, newest first',
    auth: { module: 'systemLogs', action: 'read' },
    query: ['level', 'minLevel', 'category', 'source', 'eventCode', 'requestId', 'organizationId', 'actorId', 'statusCode', 'dateFrom', 'dateTo', 'search', 'limit', 'offset'],
    response: 'SystemLogListResult ({ items: SystemLogEntry[], total, limit, offset })',
    responseSchema: 'SystemLogListResult',
  },
  {
    method: 'get', path: '/system-logs/summary', tag: 'System Logs', summary: 'Level/category counts, top failures, and the hourly error trend',
    auth: { module: 'systemLogs', action: 'read' },
    query: ['window'],
    response: 'SystemLogSummary',
    responseSchema: 'SystemLogSummary',
  },
  {
    method: 'get', path: '/system-logs/export', tag: 'System Logs', summary: 'CSV export of the current filter set (max 10000 rows)',
    auth: { module: 'systemLogs', action: 'export' },
    query: ['level', 'minLevel', 'category', 'source', 'eventCode', 'requestId', 'organizationId', 'actorId', 'statusCode', 'dateFrom', 'dateTo', 'search'],
    response: 'text/csv',
  },
  {
    method: 'get', path: '/system-logs/request/{requestId}', tag: 'System Logs', summary: 'Every entry sharing one request id, oldest first (request trace)',
    auth: { module: 'systemLogs', action: 'read' }, response: '{ items: SystemLogEntry[] }',
  },
  {
    method: 'get', path: '/system-logs/{id}', tag: 'System Logs', summary: 'One entry with its full stack and context',
    auth: { module: 'systemLogs', action: 'read' }, response: 'SystemLogEntry',
    responseSchema: 'SystemLogEntry',
  },
  {
    method: 'get', path: '/health', tag: 'Health', summary: 'Liveness probe',
    auth: undefined, response: '{ status: "ok" }',
  },
  {
    method: 'get', path: '/health/db', tag: 'Health', summary: 'Readiness probe — confirms the database is reachable',
    auth: undefined, response: '{ status: "ok" } | 503',
  },
  {
    method: 'get', path: '/health/redis', tag: 'Health', summary: 'Readiness probe — confirms Redis is reachable',
    auth: undefined, response: '{ status: "ok" } | 503',
  },
  // Surveys — Survey Builder question set, methodology version, approval,
  // and the citizen-facing public submission.
  {
    method: 'get', path: '/needs/{needId}/survey', tag: 'Surveys', summary: "Get a Need's survey (question set + status)",
    auth: { module: 'surveyBuilder', action: 'read' }, response: 'Survey',
    responseSchema: 'Survey',
  },
  {
    method: 'post', path: '/needs/{needId}/survey', tag: 'Surveys', summary: 'Create an empty (hand-built) survey for a Need',
    auth: { module: 'surveyBuilder', action: 'write' }, response: 'Survey',
    responseSchema: 'Survey',
  },
  {
    method: 'post', path: '/needs/{needId}/recommend-questions', tag: 'Surveys', summary: 'Auto-populate a survey from the Question Bank for this Need',
    auth: { module: 'surveyBuilder', action: 'write' }, response: 'Survey',
    responseSchema: 'Survey',
  },
  {
    method: 'get', path: '/custom-questions', tag: 'Surveys', summary: 'Org-wide reusable custom questions, filtered by domain/subDomain',
    auth: { module: 'surveyBuilder', action: 'read' }, query: ['domain', 'subDomain'], response: 'CustomQuestion[]',
    responseSchema: 'CustomQuestion', responseIsArray: true,
  },
  {
    method: 'patch', path: '/surveys/{id}/questions', tag: 'Surveys', summary: "Replace a draft survey's question set",
    auth: { module: 'surveyBuilder', action: 'write' }, requestSchema: 'UpdateSurveyQuestionsBody', response: 'Survey',
    responseSchema: 'Survey',
  },
  {
    method: 'patch', path: '/surveys/{id}/methodology-version', tag: 'Surveys', summary: "Set the survey's methodology version",
    auth: { module: 'surveyBuilder', action: 'write' }, requestSchema: 'SetMethodologyVersionBody', response: 'Survey',
    responseSchema: 'Survey',
  },
  {
    method: 'post', path: '/surveys/{id}/submit', tag: 'Surveys', summary: 'Researcher: submit the draft survey for Approver review',
    auth: { module: 'surveyBuilder', action: 'write' }, response: 'SurveyRecord (raw Survey row; only id/needId/studyId/title/status are frontend-typed)',
    responseSchema: 'SurveyRecord',
  },
  {
    method: 'post', path: '/surveys/{id}/approve', tag: 'Surveys', summary: 'Approver: approve and publish the survey',
    auth: { module: 'surveyBuilder', action: 'approve' }, response: 'SurveyRecord (raw Survey row; only id/needId/studyId/title/status are frontend-typed)',
    responseSchema: 'SurveyRecord',
  },
  {
    method: 'post', path: '/surveys/{id}/reject', tag: 'Surveys', summary: 'Approver: reject the submitted survey back to draft',
    auth: { module: 'surveyBuilder', action: 'approve' }, requestSchema: 'RejectSurveyBody', response: 'SurveyRecord (raw Survey row; only id/needId/studyId/title/status are frontend-typed)',
    responseSchema: 'SurveyRecord',
  },
  {
    // NOTE (discrepancy, flagged in surveys.contract.ts): the frontend
    // types this route's result as `Survey`, but that's not what
    // SurveysService.getPublicSurvey actually returns (`{ id, title,
    // status, questions }` — no methodologyVersion/approvedAt/etc.). Wired
    // to a best-effort PublicSurveyView schema built from the real backend
    // shape, per the "no FE counterpart" fallback in the batch instructions.
    method: 'get', path: '/surveys/public/{id}', tag: 'Surveys', summary: 'Citizen-facing: get a published survey by its public link id',
    auth: undefined, response: 'PublicSurveyView',
    responseSchema: 'PublicSurveyView',
  },
  {
    // NOTE: this route has neither a @RequirePermission nor an explicit
    // @Public() decorator in surveys.controller.ts — documented here as
    // public (auth: undefined) to match its actual runtime behavior, not
    // because that's confirmed to be the intended design. Flagged as a
    // possible separate follow-up in the backend remediation pass (Task 5)
    // notes, not resolved in this pass.
    method: 'post', path: '/surveys/public/{id}/submit', tag: 'Surveys', summary: 'Citizen-facing: submit answers to a published survey',
    auth: undefined, requestSchema: 'SubmitSurveyBody', response: 'SubmitAnswersResult ({ id, submittedAt } — the backend returns the full created response row, the frontend only reads these two fields)',
    responseSchema: 'SubmitAnswersResult',
  },
  {
    // NOTE (discrepancy, fixed here): previously documented as
    // `SurveyResponse[]` — SurveysService.getSurveyResponses actually
    // returns ONE stats object per call (matches the frontend's
    // SurveyResponseStats exactly), not an array of per-response records.
    method: 'get', path: '/surveys/{id}/responses', tag: 'Surveys', summary: 'Get a survey’s response stats (one object: respondent count + per-question answer distributions)',
    auth: { module: 'surveyBuilder', action: 'read' }, response: 'SurveyResponseStats',
    responseSchema: 'SurveyResponseStats',
  },
  // Priority — deterministic severity scoring, dashboards, and
  // methodology-version/lookup management.
  {
    method: 'post', path: '/needs/{needId}/priority-score', tag: 'Priority', summary: "Compute and save a Need's priority score",
    auth: { module: 'priorityScoring', action: 'create' }, query: ['surveyLinkId'], response: 'PriorityScore',
    responseSchema: 'PriorityScore',
  },
  {
    // 200 body is `PriorityScore | null` (no score computed yet) — the
    // registered schema documents the non-null shape, same convention as
    // every other nullable single-object GET in this file (e.g. StudyDetail).
    method: 'get', path: '/needs/{needId}/priority-score', tag: 'Priority', summary: "Get a Need's latest priority score",
    auth: { module: 'priorityScoring', action: 'read' }, query: ['surveyLinkId'], response: 'PriorityScore | null',
    responseSchema: 'PriorityScore',
  },
  {
    method: 'get', path: '/studies/{studyId}/surveys/{surveyId}/severity-dashboard', tag: 'Priority', summary: 'Severity dashboard for a study/survey',
    auth: { module: 'priorityScoring', action: 'read' }, query: ['villageId'], response: 'SeverityDashboardResult',
    responseSchema: 'SeverityDashboardResult',
  },
  {
    method: 'get', path: '/studies/{studyId}/surveys/{surveyId}/severity-kpis', tag: 'Priority', summary: 'KPI severity ranking for a study/survey',
    auth: { module: 'priorityScoring', action: 'read' }, query: ['villageId'], response: 'SeverityKpiRankingEntry[]',
    responseSchema: 'SeverityKpiRankingEntry', responseIsArray: true,
  },
  {
    method: 'get', path: '/studies/{studyId}/surveys/{surveyId}/questions/{questionId}', tag: 'Priority', summary: 'Per-question severity detail',
    auth: { module: 'priorityScoring', action: 'read' }, query: ['villageId'], response: 'QuestionDetailResult',
    responseSchema: 'QuestionDetailResult',
  },
  {
    method: 'post', path: '/studies/{studyId}/surveys/{surveyId}/recalculate', tag: 'Priority', summary: 'Recalculate KPI → Indicator → Sub-Domain → Domain rollups',
    auth: { module: 'priorityScoring', action: 'create' }, response: '{ success: true }',
  },
  {
    // 200 body is `VillagePriorityResult | null` (no assessment computed
    // yet) — same nullable-GET convention as /needs/{needId}/priority-score
    // above.
    method: 'get', path: '/studies/{studyId}/surveys/{surveyId}/village-priority', tag: 'Priority', summary: 'Village-level priority ranking',
    auth: { module: 'priorityScoring', action: 'read' }, query: ['villageId'], response: 'VillagePriorityResult | null',
    responseSchema: 'VillagePriorityResult',
  },
  {
    method: 'get', path: '/methodology-versions', tag: 'Priority', summary: 'List methodology versions',
    auth: { module: 'methodologyQuestionBank', action: 'read' }, response: 'MethodologyVersion[]',
    responseSchema: 'MethodologyVersion', responseIsArray: true,
  },
  {
    method: 'post', path: '/methodology-versions', tag: 'Priority', summary: 'Create a new methodology version',
    auth: { module: 'methodologyQuestionBank', action: 'create' }, requestSchema: 'CreateMethodologyVersionBody', response: 'MethodologyVersion',
    responseSchema: 'MethodologyVersion',
  },
  {
    // NOTE (discrepancy, fixed here): previously documented as returning
    // `MethodologyVersion` — PriorityService.uploadLookups actually returns
    // `{ imported: number }` (the CSV import count), matching the
    // frontend's uploadLookups() return type exactly; it never re-fetches
    // the MethodologyVersion row.
    method: 'post', path: '/methodology-versions/{id}/upload-lookups', tag: 'Priority', summary: 'Upload a scoring-lookup CSV for a methodology version',
    auth: { module: 'methodologyQuestionBank', action: 'create' }, response: 'UploadLookupsResult ({ imported: number })',
    responseSchema: 'UploadLookupsResult',
  },
  {
    method: 'get', path: '/priority-scores', tag: 'Priority', summary: 'Cross-Need priority-score dashboard for the org',
    auth: { module: 'priorityScoring', action: 'read' }, response: 'PriorityDashboardEntry[]',
    responseSchema: 'PriorityDashboardEntry', responseIsArray: true,
  },
  {
    method: 'patch', path: '/priority-scores/{id}/approve', tag: 'Priority', summary: 'Approve a computed priority score',
    auth: { module: 'priorityScoring', action: 'approve' }, response: 'PriorityScore',
    responseSchema: 'PriorityScore',
  },
  // Priority Summary — the drafting/approval workflow feeding the Reports
  // module (see report-summary.service.ts).
  {
    method: 'post', path: '/studies/{studyId}/surveys/{surveyId}/priority-summary/preview-snapshot', tag: 'Priority Summary', summary: 'Preview a priority-summary snapshot for a scope, without saving it',
    auth: { module: 'priorityScoring', action: 'read' }, requestSchema: 'SummaryScopeBody', response: 'PrioritySummaryPreview',
    responseSchema: 'PrioritySummaryPreview',
  },
  {
    // NOTE (discrepancy, fixed here): previously documented as returning a
    // bare `PrioritySummary` — ReportSummaryService.generatePrioritySummary
    // actually returns `{ summary: AiPrioritySummary, snapshot }`, matching
    // the frontend's PrioritySummaryResponse envelope, not the record alone.
    method: 'post', path: '/studies/{studyId}/surveys/{surveyId}/priority-summary/generate', tag: 'Priority Summary', summary: 'Generate and save a priority summary for a scope',
    auth: { module: 'priorityScoring', action: 'create' }, requestSchema: 'SummaryScopeBody', response: 'PrioritySummaryResponse ({ summary: PrioritySummary, snapshot })',
    responseSchema: 'PrioritySummaryResponse',
  },
  {
    // NOTE (discrepancy, fixed here): same envelope mismatch as generate
    // above — ReportSummaryService.getSummary returns `{ summary:
    // AiPrioritySummary | null, snapshot }` (or bare `null` if nothing has
    // ever been generated for this scope), not a bare PrioritySummary.
    method: 'get', path: '/studies/{studyId}/surveys/{surveyId}/priority-summary', tag: 'Priority Summary', summary: 'Get the current priority summary for a scope',
    auth: { module: 'priorityScoring', action: 'read' }, query: ['scope', 'villageId'], response: 'PrioritySummaryResponse | null ({ summary: PrioritySummary | null, snapshot })',
    responseSchema: 'PrioritySummaryResponse',
  },
  {
    method: 'patch', path: '/priority-summaries/{summaryId}', tag: 'Priority Summary', summary: "Save a draft edit to a priority summary's output JSON",
    auth: { module: 'priorityScoring', action: 'write' }, requestSchema: 'SaveDraftEditsBody', response: 'PrioritySummary',
    responseSchema: 'PrioritySummary',
  },
  {
    method: 'post', path: '/priority-summaries/{summaryId}/save', tag: 'Priority Summary', summary: 'Save (finalize a draft of) a priority summary',
    auth: { module: 'priorityScoring', action: 'write' }, requestSchema: 'SaveSummaryBody', response: 'PrioritySummary',
    responseSchema: 'PrioritySummary',
  },
  {
    method: 'get', path: '/studies/{studyId}/surveys/{surveyId}/priority-summaries/saved', tag: 'Priority Summary', summary: 'List saved priority summaries for a study/survey',
    auth: { module: 'priorityScoring', action: 'read' }, response: 'PrioritySummary[]',
    responseSchema: 'PrioritySummary', responseIsArray: true,
  },
  {
    method: 'delete', path: '/priority-summaries/{summaryId}', tag: 'Priority Summary', summary: 'Delete a saved priority summary',
    auth: { module: 'priorityScoring', action: 'write' }, response: '204 No Content',
  },
  {
    method: 'post', path: '/priority-summaries/{summaryId}/confirm', tag: 'Priority Summary', summary: 'Confirm (approve) a priority summary',
    auth: { module: 'priorityScoring', action: 'approve' }, response: 'PrioritySummary',
    responseSchema: 'PrioritySummary',
  },
  {
    method: 'get', path: '/studies/{studyId}/surveys/{surveyId}/priority-summary/history', tag: 'Priority Summary', summary: 'Priority-summary revision history for a scope',
    auth: { module: 'priorityScoring', action: 'read' }, query: ['scope'], response: 'PrioritySummary[]',
    responseSchema: 'PrioritySummary', responseIsArray: true,
  },
  {
    method: 'patch', path: '/evidence/{evidenceId}/toggle-inclusion', tag: 'Priority Summary', summary: "Toggle an evidence item's inclusion in the generated report",
    auth: { module: 'studySurvey', action: 'write' }, requestSchema: 'ToggleEvidenceInclusionBody', response: 'Evidence',
    responseSchema: 'Evidence',
  },
  {
    // NOT wired to a responseSchema: ReportSummaryService.saveReportFromSummary
    // returns a raw `Report` DB row, but no `Report` schema is registered
    // anywhere in this file (the Reports tag itself is out of scope for
    // this pass) and the frontend's saveReportFromSummary() types its
    // result as an untyped `Record<string, unknown>` — there is no FE
    // shape to match and registering a full Report schema belongs with the
    // (separate, not-yet-done) Reports tag documentation. Left as
    // free-text per the "no FE counterpart, out of batch scope" case.
    method: 'post', path: '/priority-summaries/{summaryId}/save-report', tag: 'Priority Summary', summary: 'Save a priority summary as a formal Report',
    auth: { module: 'reportsDashboards', action: 'create' }, response: 'Report',
  },
];

function toOpenApiPath(path: string): string {
  // {id} is already OpenAPI's placeholder syntax — no conversion needed,
  // just prefix with the app's global prefix (see main.ts's setGlobalPrefix).
  return `/api${path}`;
}

function buildOperation(route: RouteDoc): Record<string, unknown> {
  const description =
    route.auth === undefined
      ? 'No authentication required.'
      : route.auth === 'session'
        ? 'Requires a signed-in session.'
        : `Requires ${route.auth.module}:${route.auth.action}.`;

  const parameters = (route.query ?? []).map((name) => ({
    name,
    in: 'query',
    required: false,
    schema: { type: 'string' },
  }));

  // Every {name} placeholder in the path needs a matching path parameter,
  // not just {id} — routes like /studies/{studyId}/need have their own.
  const pathParamNames = [...route.path.matchAll(/{([^}]+)}/g)].map((m) => m[1]);
  const pathParams = pathParamNames.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));

  return {
    tags: [route.tag],
    summary: route.summary,
    description,
    ...(pathParams.length + parameters.length > 0
      ? { parameters: [...pathParams, ...parameters] }
      : {}),
    ...(route.requestSchema
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${route.requestSchema}` } } },
          },
        }
      : {}),
    responses: {
      '200': {
        description: route.response,
        ...(route.responseSchema
          ? {
              content: {
                'application/json': {
                  schema: route.responseIsArray
                    ? { type: 'array', items: { $ref: `#/components/schemas/${route.responseSchema}` } }
                    : { $ref: `#/components/schemas/${route.responseSchema}` },
                },
              },
            }
          : {}),
      },
    },
    ...(route.auth && route.auth !== 'session' ? { 'x-required-permission': route.auth } : {}),
  };
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const key = toOpenApiPath(route.path);
    paths[key] = { ...(paths[key] ?? {}), [route.method]: buildOperation(route) };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'cnap-api',
      version: '0.1.0',
      description:
        'Session is a bearer token or the rio_session httpOnly cookie. Routes ' +
        'marked with a required permission additionally need the caller\'s ' +
        'role to have that module/action grant (see RBAC role-matrix.ts).',
    },
    tags: TAGS,
    paths,
    components: { schemas: getRegisteredSchemas() },
  };
}

export function setupOpenApi(app: INestApplication): void {
  const doc = buildOpenApiDocument();
  const http = app.getHttpAdapter().getInstance();
  http.get('/openapi.json', (_req: Request, res: Response) => res.json(doc));
  http.use('/docs', swaggerUi.serve, swaggerUi.setup(doc));
}
