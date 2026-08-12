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
  // RIO-NFR-016 — the persisted operational log (system_logs). Deliberately
  // not folded into archiveSharingAudit: that module is held read-only by
  // ngo_admin, center_supervisor, data_analyst and others, and operational
  // rows carry stack traces, internal paths and integration detail that
  // belong to platform operations rather than tenant governance. Granted to
  // system_admin alone.
  'systemLogs',
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
const RO: Grant = { read: true };

export const ROLE_MATRIX: RoleDef[] = [
  // RIO-RBAC-001 module-permission matrix (client-confirmed, Aug 11): NGO
  // Admin is no longer "full access to every module in its own entity" —
  // that assumption predates this matrix. Roles & Permissions and the
  // Audit Log stay System-Admin-only; Approve is Human Reviewer's alone on
  // Studies/Needs/Surveys; Report authoring (create/write/approve) moves
  // to the Researcher/Reviewer pair, leaving Admin view+export+share only.
  { id: 'role_ngo_admin', key: 'ngo_admin', name: 'NGO Admin', description: 'Account owner — manages its own entity, teams, and studies, with approval/report-authoring held by other roles.', crossEntity: false, permissions: [
    // Organization (view+edit, no create) and Users (view+create+edit) share
    // the same entityTeam module in code — union of the two columns.
    perm('entityTeam', { read: true, write: true, create: true }),
    perm('rolesPermissions'),
    perm('onboardingConsent', { read: true, write: true, create: true, approve: true, export: true, share: true }),
    perm('methodologyQuestionBank', RO),
    perm('studySurvey', { read: true, write: true, create: true, export: true, share: true }),
    perm('dataCollection', { read: true, write: true, create: true, export: true }),
    perm('dataImport', { read: true, write: true, create: true, approve: true, export: true, share: true }),
    perm('citizenChannel', { read: true, write: true, create: true, approve: true, export: true, share: true }),
    perm('aiReview', { read: true, write: true, create: true, approve: true, export: true, share: true }),
    perm('priorityScoring', { read: true, export: true }),
    perm('reportsDashboards', { read: true, export: true, share: true }),
    // ⚠️ Module conflict, resolved deliberately: the confirmed matrix gives
    // NGO Admin "Sh" (Share) on Studies/Reports but no Audit/System Logs
    // access at all. In code, both Study/Report Sharing decisions (see
    // sharing.controller.ts / report-sharing.controller.ts) AND the Audit
    // Log (audit.controller.ts) are gated on this SAME module, and both use
    // the SAME `read` action for two different things (list sharing
    // requests vs. view the audit log) — there is no way to grant one
    // without the other at the current permission granularity. Sharing is
    // pre-existing, already-shipped, heavily tested functionality (FR-014);
    // silently breaking it to achieve a strict Audit-Log lockout would be a
    // real regression the client did not ask for. Kept `read`/`create`/
    // `approve` so Sharing keeps working — `export` stays off (audit CSV
    // export has no Sharing-side use). Net effect: NGO Admin can technically
    // still view the raw Audit Log list via this grant, which is NOT what
    // the matrix asked for — flagging this as needing either a real
    // read-vs-read module split in a follow-up, or explicit client
    // confirmation that Sharing capability wins over strict Audit lockout.
    perm('archiveSharingAudit', { read: true, create: true, approve: true }),
    perm('surveyBuilder', { read: true, write: true, create: true, export: true }),
    perm('ncnpReport'),
    perm('systemLogs'),
  ] },
  { id: 'role_ngo_research_officer', key: 'ngo_research_officer', name: 'NGO Research Officer', description: 'Creates studies and surveys from the question bank and enters data.', crossEntity: false, permissions: [
    // RIO-RBAC-001 matrix (Aug 11): view-only on Organization/Users now
    // (was none) — matches the client-confirmed "Researcher: V" row.
    perm('entityTeam', RO), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO),
    // No `export` on Studies per the confirmed matrix (Researcher: V/C/E) —
    // was granted before this clarification.
    perm('studySurvey', { read: true, write: true, create: true }),
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
    // No `create` per the confirmed matrix (Researcher/Dashboard: V only).
    perm('priorityScoring', RO),
    // RIO-RBAC-001 matrix, refined (Aug 12, client-confirmed): Researcher
    // holds View/Create/Edit on Reports — `write` (the officer-confirm
    // step) was initially left off per a literal reading of "V/C" in the
    // matrix, but that made System Admin the only role able to confirm any
    // report, which doesn't hold up operationally (System Admin has no real
    // stake in report content). "Confirm" is the same actor finishing what
    // they just created, not a separate reviewer checkpoint — the two-step
    // workflow's real separation is Researcher (create+confirm) vs. Human
    // Reviewer (independent approve), not Researcher vs. System Admin.
    perm('reportsDashboards', { read: true, create: true, write: true }),
    // RIO-RBAC-001 matrix: Researcher holds no Audit/System Logs access at
    // all — this previously doubled as "can request cross-org Sharing,"
    // which is removed as a side effect. Flag if the Sharing-request
    // capability still needs a home now that this grant is gone.
    perm('archiveSharingAudit'),
    // `create` added per the confirmed matrix (Researcher/Surveys: V/C/E).
    perm('surveyBuilder', { read: true, write: true, create: true }),
    perm('ncnpReport'),
  ] },
  { id: 'role_field_researcher', key: 'field_researcher', name: 'Field Researcher', description: 'Enters needs and documents the source and field notes.', crossEntity: false, permissions: [
    // Confirmed matrix (Jagannathan, Aug 12): Organization/Users = View.
    perm('entityTeam', RO), perm('rolesPermissions'), perm('onboardingConsent'),
    // Question Bank = View (unchanged); Studies = View/Create/Edit — widened
    // from View-only, mirrors this role's existing Needs/Evidence grant.
    perm('methodologyQuestionBank', RO), perm('studySurvey', { read: true, create: true, write: true }),
    // Needs/Evidence = View/Create/Edit (already matched — same grant
    // covers both, and the confirmed matrix gives both the same values for
    // this role, so no shared-module conflict here).
    perm('dataCollection', { read: true, write: true, create: true }),
    perm('dataImport'), perm('citizenChannel'), perm('aiReview'), perm('priorityScoring'),
    // Reports = View — was no access.
    perm('reportsDashboards', RO), perm('archiveSharingAudit'),
    // Surveys/Survey Builder = View/Create/Edit — was no access.
    perm('surveyBuilder', { read: true, create: true, write: true }), perm('ncnpReport'),
  ] },
  { id: 'role_human_reviewer', key: 'human_reviewer', name: 'Human Reviewer', description: 'Approves or rejects (with comments) a finalized Survey before it publishes.', crossEntity: false, permissions: [
    // RIO-RBAC-001 matrix (Aug 11): view-only on Organization/Users now
    // (was none).
    perm('entityTeam', RO), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO),
    // Matrix: Studies = View + Approve only for this role now — the
    // `create` grant that let the Approver generate public links
    // themselves is removed per the confirmed matrix.
    perm('studySurvey', { read: true, approve: true }),
    // Matrix: Needs = View + Approve (was view-only) — Approve is inert on
    // the Evidence/Documents side, since no evidence endpoint checks it.
    perm('dataCollection', { read: true, approve: true }),
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
    perm('reportsDashboards', { read: true, approve: true, export: true }),
    // RIO-RBAC-001 matrix: Audit/System Logs = none for this role (was
    // read-only).
    perm('archiveSharingAudit'),
    // RIO-RBAC-001 matrix (Aug 11, client-confirmed): Surveys = View +
    // Approve only for this role — `write` is REMOVED here. This reverses
    // an earlier, deliberate product decision (see the removed comment
    // above, and role_ngo_research_officer's own surveyBuilder grant) that
    // the Reviewer/Approver also curates questions alongside the
    // Researcher. Flagging this explicitly: if the Reviewer is still
    // expected to edit/override questions before approving (as the earlier
    // design intended), this specific line needs a follow-up confirmation
    // with the client before treating it as final — it directly contradicts
    // prior documented behavior, not just an incremental narrowing.
    perm('surveyBuilder', { read: true, approve: true }),
    perm('ncnpReport'),
  ] },
  { id: 'role_data_analyst', key: 'data_analyst', name: 'Data Analyst', description: 'Processes data, reviews quality, and prepares reports and dashboards.', crossEntity: false, permissions: [
    // Confirmed matrix (Jagannathan, Aug 12): Organization/Users = View.
    perm('entityTeam', RO), perm('rolesPermissions'), perm('onboardingConsent'),
    // Question Bank = View; Studies = View — both unchanged, already matched.
    perm('methodologyQuestionBank', RO), perm('studySurvey', RO),
    // Confirmed (Jagannathan, Aug 12): Needs = View, Evidence/Documents =
    // View/Export — resolves to plain View here, since no endpoint in
    // EvidenceDocumentsController/EvidenceController checks `export` at
    // all (verified — Evidence has no export feature to grant). Ends the
    // RIO-DATA-003 temporary widening (Data Analyst could previously
    // create Needs directly) per this confirmation.
    perm('dataCollection', RO),
    perm('dataImport', { read: true, write: true, create: true }), perm('citizenChannel'),
    // Confirmed (Jagannathan, Aug 12): Data Analyst owns "Generating the AI
    // Evidence Summary" and "Generating the Combined Summary Report" — both
    // gated on aiReview:write in this codebase (see
    // EvidenceDocumentsController / CombinedReportSummaryController). Note:
    // this same flag also covers the unrelated Need-classification-trigger
    // action (already held by ngo_admin/ngo_research_officer) — Data
    // Analyst can now trigger/retry that too, a minor side effect of one
    // flag covering three distinct actions, not something separately asked
    // for but accepted as harmless overlap.
    perm('aiReview', { read: true, write: true }),
    // Confirmed (Jagannathan, Aug 12): Data Analyst "reviews and validates"
    // the Priority Score (PriorityDashboardController's :id/approve) and
    // generates the AI Summary (PrioritySummaryController's
    // generate/save/confirm) — both require create/write/approve on this
    // module, superseding the module table's narrower View/Export-only row.
    perm('priorityScoring', { read: true, write: true, create: true, approve: true, export: true }),
    // Confirmed matrix: Reports = View/Create/Edit/Export/Share — `share`
    // added (was missing), no `approve` (matches the confirmed row exactly).
    perm('reportsDashboards', { read: true, write: true, create: true, export: true, share: true }),
    // Confirmed matrix: Audit/System Logs = none — was read-only, removed.
    perm('archiveSharingAudit'),
    // Confirmed matrix: Surveys/Survey Builder = View.
    perm('surveyBuilder', RO), perm('ncnpReport'),
  ] },
  { id: 'role_system_admin', key: 'system_admin', name: 'System Admin', description: 'Manages accounts, roles, permissions, audit log, and configuration settings.', crossEntity: true, permissions: [
    perm('entityTeam', { read: true, write: true, create: true, export: true }),
    // RIO-RBAC-001 matrix (Aug 11): System Admin gets real write/create on
    // Roles & Permissions, Studies, Needs, Survey Builder, Question Bank
    // and Reports now — this role was previously read-only on almost
    // everything outside its own Administration/Audit scope, which didn't
    // match the confirmed matrix's "V/C/E(/Ap/Ex/Sh)" rows for System Admin
    // across those modules.
    perm('rolesPermissions', { read: true, write: true, create: true }),
    perm('onboardingConsent', RO), perm('methodologyQuestionBank', { read: true, write: true, create: true }),
    perm('studySurvey', { read: true, write: true, create: true, approve: true, export: true, share: true }),
    perm('dataCollection', { read: true, write: true, create: true, approve: true, export: true, share: true }),
    perm('dataImport', RO), perm('citizenChannel', RO),
    perm('aiReview', RO),
    // `export` added per the confirmed matrix (System Admin/Dashboard: V/Ex).
    perm('priorityScoring', { read: true, export: true }),
    perm('reportsDashboards', { read: true, write: true, create: true, approve: true, export: true, share: true }),
    // `export` (on top of `read`) — RIO-FR-007: the BRD names System Admin as
    // the role that "manages ... the audit log", but this grant was read-only,
    // so the one role responsible for the audit log couldn't download it. The
    // audit CSV export (AuditController's GET /audit/export) is gated on
    // exactly `archiveSharingAudit:export`, and that action gates nothing else
    // in this module — Archive is read-only and Sharing uses create/approve —
    // so this widens audit export only, not Archive or Sharing.
    perm('archiveSharingAudit', { read: true, export: true }),
    perm('surveyBuilder', { read: true, write: true, create: true, approve: true, export: true, share: true }),
    // Generate a new NCNP Compiled Report snapshot for review, and publish
    // one a System Reviewer has already approved — `write` covers both
    // (this role never Approves/Rejects itself; that's exclusively
    // system_reviewer's `approve` bit below).
    perm('ncnpReport', { read: true, write: true }),
    // RIO-NFR-016 — the operational log. System Admin is the only role that
    // holds this module at all: the rows carry stack traces, internal
    // paths and cross-tenant detail. `export` gates the CSV download only
    // (GET /system-logs/export); there is no write action to grant, since
    // the table has no HTTP write path by design.
    perm('systemLogs', { read: true, export: true }),
  ] },
  { id: 'role_read_only_viewer', key: 'read_only_viewer', name: 'Read-only Viewer', description: 'Views authorized outputs without editing.', crossEntity: false, permissions: [
    // Confirmed matrix (Jagannathan, Aug 12): Organization/Users = View.
    perm('entityTeam', RO), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO), perm('studySurvey', RO), perm('dataCollection', RO),
    perm('dataImport', RO), perm('citizenChannel'), perm('aiReview', RO), perm('priorityScoring', RO),
    // Confirmed (Jagannathan, Aug 12): Reports = View only for this role —
    // no Export. Export was in an earlier build; removed per this
    // confirmation.
    perm('reportsDashboards', RO),
    // Confirmed matrix: Audit/System Logs = none — was read-only, removed.
    perm('archiveSharingAudit'),
    // Confirmed matrix: Surveys/Survey Builder = View — was no access.
    perm('surveyBuilder', RO), perm('ncnpReport'),
  ] },
  // RIO-RBAC-001 (client-confirmed): "Center supervisor / NCNP supervisor"
  // is one combined role in the client's own Roles & Permissions sheet, not
  // two — "Program Supervisor" and "NCNP User" were built as separate roles
  // without that confirmation. The client's answer: one combined role,
  // cross-entity view/follow authority only, no edit rights on entity data.
  // `role_ncnp_user` (previously a separate role here) is retired — no
  // seeded or real user was ever assigned it (checked before removing), and
  // its own access was actually broken: the NCNP Compiled Report controller
  // gates on `archiveSharingAudit:read`, which the old ncnp_user grant
  // didn't hold (every module was `perm(m)` with no grant) — this role's
  // read access, including crossEntity: true here, already covers exactly
  // what NCNP viewing needs (assertCrossEntity() is the report's own
  // additional check — see NcnpReportService).
  { id: 'role_center_supervisor', key: 'center_supervisor', name: 'Center Supervisor (NCNP Supervisor)', description: 'Cross-entity view/follow authority to monitor studies, data, reports and the NCNP Compiled Report — no edit rights on entity data.', crossEntity: true, permissions: [
    perm('entityTeam', RO), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO), perm('studySurvey', RO), perm('dataCollection', RO),
    perm('dataImport', RO), perm('citizenChannel'), perm('aiReview', RO),
    // `export` added per the confirmed matrix (Center Supervisor/Dashboard: V/Ex).
    perm('priorityScoring', { read: true, export: true }),
    perm('reportsDashboards', { read: true, export: true }),
    // `export` added per the confirmed matrix (Center Supervisor/Audit: V/Ex).
    perm('archiveSharingAudit', { read: true, export: true }),
    // `read` added per the confirmed matrix (Center Supervisor/Surveys: V) —
    // this role previously had zero access to Survey Builder, not even view.
    perm('surveyBuilder', RO), perm('ncnpReport'),
  ] },
  { id: 'role_citizen_guest', key: 'citizen_guest', name: 'Citizen / Beneficiary Guest', description: 'Responds to surveys through OTP verification; no internal application access.', crossEntity: false,
    permissions: PERMISSION_MODULES.map((m) => (m === 'citizenChannel' ? perm(m, { create: true }) : perm(m))) },
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
    // RIO-RBAC-001 matrix (Aug 11): view-only on Organization/Users now
    // (was none) — matches the confirmed "System Reviewer: V" row.
    perm('entityTeam', RO), perm('rolesPermissions'), perm('onboardingConsent'), perm('methodologyQuestionBank', RO),
    perm('studySurvey', RO), perm('dataCollection', RO), perm('dataImport', RO), perm('citizenChannel'),
    perm('aiReview', RO), perm('priorityScoring', RO),
    // ⚠️ FLAGGED, NOT IMPLEMENTED AS LITERALLY GIVEN: the confirmed matrix
    // lists Reports = View/Approve/Export for System Reviewer. Deliberately
    // NOT adding `approve` here — this module (reportsDashboards) is the
    // general RPT01-14 Reports feature, not the NCNP Compiled Report
    // (that's the separate `ncnpReport` module below, which already grants
    // this role `approve`). Per this file's own prior documented warning,
    // reportsDashboards:approve has no additional crossEntity scoping in
    // ReportsController, so granting it here would let a System Reviewer
    // approve/reject/archive any org's RPT01-14 reports — a cross-tenant
    // capability this role was deliberately never given. Recommend
    // confirming with the client whether "Reports: Approve" in the matrix
    // meant the NCNP report specifically (already covered) before granting
    // this literally.
    perm('reportsDashboards', { read: true, export: true }),
    perm('archiveSharingAudit'),
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
