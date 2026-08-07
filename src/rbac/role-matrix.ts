export const PERMISSION_MODULES = [
  'entityTeam', 'rolesPermissions', 'onboardingConsent', 'methodologyQuestionBank',
  'studySurvey', 'dataCollection', 'dataImport', 'citizenChannel',
  'aiReview', 'priorityScoring', 'reportsDashboards', 'archiveSharingAudit',
  // Survey Builder (Question Bank + AI-assisted questionnaire design) is its
  // own independent methodology feature, not a Study feature — deliberately
  // its own module rather than reusing studySurvey. Publish Survey/QR and
  // the Citizen public flow are unrelated and keep their existing modules.
  'surveyBuilder',
  // The NCNP Compiled Report's own review workflow — deliberately not a
  // reuse of reportsDashboards (see NcnpReportReview's schema comment):
  // granting reportsDashboards:approve to System Reviewer would also grant
  // approve rights over the unrelated RPT01-14 Reports feature, since that
  // controller has no crossEntity guard of its own. `approve` = System
  // Reviewer's approve/reject decision; `write` = System Admin's
  // generate/publish actions.
  'ncnpReport',
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];
export type PermissionAction = 'read' | 'write' | 'create' | 'approve' | 'export' | 'share';

export interface ModulePermission {
  module: PermissionModule;
  read: boolean; write: boolean; create: boolean; approve: boolean; export: boolean; share: boolean;
}
export interface RoleDef {
  id: string; key: string; name: string; description: string; crossEntity: boolean;
  permissions: ModulePermission[];
}

interface Grant { read?: boolean; write?: boolean; create?: boolean; approve?: boolean; export?: boolean; share?: boolean }
function perm(module: PermissionModule, g: Grant = {}): ModulePermission {
  return { module, read: g.read ?? false, write: g.write ?? false, create: g.create ?? false, approve: g.approve ?? false, export: g.export ?? false, share: g.share ?? false };
}
// "Full access to every module within its own entity" — `ncnpReport` is
// explicitly excluded (left at no access) since it's the one module that
// isn't entity-scoped at all: it's the cross-org, kingdom-wide NCNP
// Compiled Report, gated to System Admin/System Reviewer only. Without
// this exclusion, NGO Admin (the only role using this helper) silently
// inherited full read/write/approve/export on it the moment `ncnpReport`
// was added to `PERMISSION_MODULES` — a real bug: the backend's own
// `assertCrossEntity()` check would still block NGO Admin from actually
// using those endpoints, but the frontend's permission-based UI has no
// such check, so it showed NCNP-only controls (Generate, the Consolidated
// category filter/column) to a role that could never act on them.
function fullAccess(): ModulePermission[] {
  return PERMISSION_MODULES.map((m) =>
    m === 'ncnpReport' ? perm(m) : perm(m, { read: true, write: true, create: true, approve: true, export: true, share: true }),
  );
}
const RO: Grant = { read: true };

export const ROLE_MATRIX: RoleDef[] = [
  { id: 'role_ngo_admin', key: 'ngo_admin', name: 'NGO Admin', description: 'Account owner. Full access to every module within its own entity.', crossEntity: false, permissions: fullAccess() },
  { id: 'role_ngo_research_officer', key: 'ngo_research_officer', name: 'NGO Research Officer', description: 'Creates studies and surveys from the question bank and enters data.', crossEntity: false, permissions: [
    perm('entityTeam'), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO),
    perm('studySurvey', { read: true, write: true, create: true, export: true }),
    perm('dataCollection', { read: true, write: true, create: true }),
    perm('dataImport', { read: true, write: true, create: true }),
    perm('citizenChannel'),
    // Researcher can trigger/retry classification (`write`) but does not
    // Approve/Override/Reject it — that stays exclusively role_human_reviewer's
    // `approve` below, per the client's Roles & Permissions sheet (Entity
    // research officer: no Approve grant; Human reviewer: Approve =
    // Classification/priority). The Approver also exclusively owns the
    // separate Survey Approve & Publish step (surveyBuilder:approve).
    perm('aiReview', { read: true, write: true }),
    // `create` (not full write/approve) — lets them trigger
    // Recalculate/Run Priority Scoring on their own studies' Insights page,
    // same as Admin; they still can't approve a priority score elsewhere in
    // the app (no such action exists on this role's other screens anyway).
    perm('priorityScoring', { read: true, create: true }),
    // `create` + `write` (not `approve`) — product decision: the Researcher
    // generates a report draft from their own study's data AND confirms it
    // themselves (ReportsController's :id/confirm, gated on `write`) before
    // it reaches the Approver — generate-then-confirm is one continuous step
    // owned by the Officer, not split across a separate Data Analyst
    // handoff. They still can't approve/reject/archive it themselves (no
    // `approve` here) — that stays the Reviewer/Approver's (and NGO Admin's)
    // job, and they're notified via the Reviewer SLA alert once confirmed
    // (see ReviewerSlaService).
    perm('reportsDashboards', { read: true, write: true, create: true, export: true }),
    // Read-only Archive + able to request cross-org Sharing access (the
    // owning org's admin still has to approve — see SharingService.decide).
    perm('archiveSharingAudit', { read: true, create: true }),
    // `write` (not `approve`) — product decision: the Researcher now
    // curates questions too (select Domain/Sub-domain when AI can't
    // classify, add from Question Bank, add/remove custom questions),
    // alongside the Reviewer/Approver who retains the same `write` plus
    // `approve` (see role_human_reviewer below) — publishing the finished
    // survey stays exclusively the Approver's `approve` action.
    perm('surveyBuilder', { read: true, write: true }),
    perm('ncnpReport'),
  ] },
  { id: 'role_field_researcher', key: 'field_researcher', name: 'Field Researcher', description: 'Enters needs and documents the source and field notes.', crossEntity: false, permissions: [
    perm('entityTeam'), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO), perm('studySurvey', RO),
    perm('dataCollection', { read: true, write: true, create: true }),
    perm('dataImport'), perm('citizenChannel'), perm('aiReview'), perm('priorityScoring'),
    perm('reportsDashboards'), perm('archiveSharingAudit'), perm('surveyBuilder'), perm('ncnpReport'),
  ] },
  { id: 'role_human_reviewer', key: 'human_reviewer', name: 'Reviewer/Approver', description: 'Approves or rejects (with comments) a finalized Survey before it publishes.', crossEntity: false, permissions: [
    perm('entityTeam'), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO),
    // `create` (not full `write`) — once a survey is published, the
    // Approver can generate its public data-collection links themselves
    // rather than waiting on the Researcher, but still can't deactivate an
    // existing link or edit the underlying survey (that stays `write`,
    // which they don't hold).
    perm('studySurvey', { read: true, create: true }),
    perm('dataCollection', RO),
    perm('dataImport', RO), perm('citizenChannel', RO),
    // `approve` (not `write`) — deciding on an AI classification
    // (Approve/Override/Reject — see
    // AiDecisionsService.approveAiReview/rejectAiReview) is shared with the
    // Researcher now (full parity — see role_ngo_research_officer above,
    // which also holds `approve`), a deliberate product decision that the
    // Approver is no longer a mandatory second reviewer for classification
    // specifically. This role never triggers classification/Retry itself
    // (no `write`) — that's still the Researcher's own action.
    perm('aiReview', { read: true, approve: true }),
    perm('priorityScoring', RO),
    // Reviewer's work starts at Studies/Reviewer-SLA, not an executive
    // dashboard, but they still need read access to Reports/Archive/Sharing
    // once a study's classification/review work is done. `export` —
    // product decision: the Approver can export a report's PDF/Excel
    // themselves, same as the Research Officer (reportsDashboards.export
    // above) — not just read it on-screen. `approve` — this is the actual
    // Approve/Reject/Archive step of the Report workflow (see
    // ReportsController's :id/approve, :id/reject, :id/archive, all gated
    // on this exact action) — without it the Approver could only read and
    // export a report, never release or reject one, which defeats the
    // Officer-confirms/Approver-approves two-step workflow entirely.
    perm('reportsDashboards', { read: true, approve: true, export: true }), perm('archiveSharingAudit', RO),
    // `write` — curating the suggested question list (add from Question
    // Bank/add custom/remove/reorder) is shared with the Researcher now
    // (see role_ngo_research_officer above), alongside `approve` (which
    // covers Approve/Override/Reject — see
    // AiDecisionsService.approveAiReview/rejectAiReview — and legacy
    // Survey approve/reject/publish via SurveysService), which stays
    // exclusive to this role.
    perm('surveyBuilder', { read: true, write: true, approve: true }),
    perm('ncnpReport'),
  ] },
  { id: 'role_data_analyst', key: 'data_analyst', name: 'Data Analyst', description: 'Processes data, reviews quality, and prepares reports and dashboards.', crossEntity: false, permissions: [
    perm('entityTeam'), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO), perm('studySurvey', RO), perm('dataCollection', RO),
    perm('dataImport', { read: true, write: true, create: true }), perm('citizenChannel'),
    perm('aiReview', RO),
    perm('priorityScoring', { read: true, write: true, create: true, approve: true, export: true }),
    perm('reportsDashboards', { read: true, write: true, create: true, export: true }),
    perm('archiveSharingAudit', RO), perm('surveyBuilder'), perm('ncnpReport'),
  ] },
  { id: 'role_system_admin', key: 'system_admin', name: 'System Admin', description: 'Manages accounts, roles, permissions, audit log, and configuration settings.', crossEntity: true, permissions: [
    perm('entityTeam', { read: true, write: true, create: true, export: true }),
    perm('rolesPermissions', RO), perm('onboardingConsent', RO), perm('methodologyQuestionBank', RO),
    perm('studySurvey', RO), perm('dataCollection', RO), perm('dataImport', RO), perm('citizenChannel', RO),
    perm('aiReview', RO), perm('priorityScoring', RO), perm('reportsDashboards', RO), perm('archiveSharingAudit', RO),
    perm('surveyBuilder'),
    // Generate a new NCNP Compiled Report snapshot for review, and publish
    // one a System Reviewer has already approved — `write` covers both
    // (this role never Approves/Rejects itself; that's exclusively
    // system_reviewer's `approve` bit below).
    perm('ncnpReport', { read: true, write: true }),
  ] },
  { id: 'role_read_only_viewer', key: 'read_only_viewer', name: 'Read-only Viewer', description: 'Views authorized outputs without editing.', crossEntity: false, permissions: [
    perm('entityTeam'), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO), perm('studySurvey', RO), perm('dataCollection', RO),
    perm('dataImport', RO), perm('citizenChannel'), perm('aiReview', RO), perm('priorityScoring', RO),
    perm('reportsDashboards', { read: true, export: true }), perm('archiveSharingAudit', RO), perm('surveyBuilder'), perm('ncnpReport'),
  ] },
  { id: 'role_center_supervisor', key: 'center_supervisor', name: 'Center Supervisor', description: 'Cross-entity supervisory authority to follow studies, data, and reports for quality.', crossEntity: true, permissions: [
    perm('entityTeam', RO), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO), perm('studySurvey', RO), perm('dataCollection', RO),
    perm('dataImport', RO), perm('citizenChannel'), perm('aiReview', RO), perm('priorityScoring', RO),
    perm('reportsDashboards', { read: true, export: true }), perm('archiveSharingAudit', RO), perm('surveyBuilder'), perm('ncnpReport'),
  ] },
  { id: 'role_citizen_guest', key: 'citizen_guest', name: 'Citizen / Beneficiary Guest', description: 'Submits a need as a data source via OTP; not added before human review.', crossEntity: false,
    permissions: PERMISSION_MODULES.map((m) => (m === 'citizenChannel' ? perm(m, { create: true }) : perm(m))) },
  // National Council for NGO Partnerships viewer — deliberately the
  // narrowest cross-entity role: `crossEntity: true` alone is what unlocks
  // the NCNP Compiled Report (its access check is `assertCrossEntity()`,
  // not a `reportsDashboards` permission — see NcnpReportService), and every
  // other module is left with no access at all, unlike System Admin/Center
  // Supervisor which are broader operational roles that happen to also
  // qualify. This role sees the NCNP Compiled Report only, nothing else —
  // no RPT01-14 report list, no org/study/survey management.
  { id: 'role_ncnp_user', key: 'ncnp_user', name: 'NCNP User', description: 'Views the national, kingdom-wide NCNP Compiled Report. No access to any other module.', crossEntity: true,
    permissions: PERMISSION_MODULES.map((m) => perm(m)) },
  // System Reviewer — reviews the NCNP Compiled Report before it publishes
  // (System Admin generates -> System Reviewer approves/rejects with
  // mandatory notes -> System Admin does the final publish; see
  // NcnpReportReviewService). Read-only everywhere else it's granted at
  // all (Needs/Surveys/Uploaded Documents/AI classification data) — no
  // create/write/approve on any of those, and no grant whatsoever on
  // entityTeam/rolesPermissions/onboardingConsent/archiveSharingAudit, so
  // Administration and the Audit Log stay exclusively System Admin's.
  // `aiReview` is read-only here specifically so this role can see
  // classification/duplicate data if a future merge-suggestion feature
  // needs it — no merge-confirm/reject action exists anywhere yet (see the
  // NCNP Report Review implementation plan), so nothing beyond `read` is
  // granted for it today.
  { id: 'role_system_reviewer', key: 'system_reviewer', name: 'System Reviewer', description: 'Reviews the NCNP Compiled Report — approves or rejects (with mandatory notes) before System Admin publishes it. Read-only everywhere else.', crossEntity: true, permissions: [
    perm('entityTeam'), perm('rolesPermissions'), perm('onboardingConsent'), perm('methodologyQuestionBank', RO),
    perm('studySurvey', RO), perm('dataCollection', RO), perm('dataImport', RO), perm('citizenChannel'),
    // reportsDashboards read + export — "View and download NGO Reports"
    // (the client's "Documents" menu reuses this existing module/page); no
    // approve/write, so RPT01-14 confirm/approve/reject/archive stay out of
    // reach (those need `write`/`approve`, neither granted here).
    perm('aiReview', RO), perm('priorityScoring', RO), perm('reportsDashboards', { read: true, export: true }), perm('archiveSharingAudit'),
    perm('surveyBuilder', RO),
    perm('ncnpReport', { read: true, approve: true }),
  ] },
];

// citizen_guest is a public data source, not a login-capable account — excluded from user assignment.
export const LOGIN_ROLE_KEYS = ROLE_MATRIX.filter((r) => r.key !== 'citizen_guest').map((r) => r.key);

export function roleByKey(key: string): RoleDef | undefined {
  return ROLE_MATRIX.find((r) => r.key === key);
}
export function can(roleKey: string | undefined, module: PermissionModule, action: PermissionAction): boolean {
  if (!roleKey) return false;
  const p = roleByKey(roleKey)?.permissions.find((x) => x.module === module);
  return p ? p[action] === true : false;
}
