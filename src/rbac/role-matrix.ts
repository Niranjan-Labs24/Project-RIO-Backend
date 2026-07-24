export const PERMISSION_MODULES = [
  'entityTeam', 'rolesPermissions', 'onboardingConsent', 'methodologyQuestionBank',
  'studySurvey', 'dataCollection', 'dataImport', 'citizenChannel',
  'aiReview', 'priorityScoring', 'reportsDashboards', 'archiveSharingAudit',
  // Survey Builder (Question Bank + AI-assisted questionnaire design) is its
  // own independent methodology feature, not a Study feature — deliberately
  // its own module rather than reusing studySurvey. Publish Survey/QR and
  // the Citizen public flow are unrelated and keep their existing modules.
  'surveyBuilder',
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
function fullAccess(): ModulePermission[] {
  return PERMISSION_MODULES.map((m) => perm(m, { read: true, write: true, create: true, approve: true, export: true, share: true }));
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
    // `write` (not `approve`) — can trigger/retry automatic AI
    // Classification on their own Needs, but the actual decision
    // (Approve/Override/Reject) is entirely the Reviewer/Approver's job —
    // see role_human_reviewer below, which holds `approve` instead.
    perm('aiReview', { read: true, write: true }),
    // `create` (not full write/approve) — lets them trigger
    // Recalculate/Run Priority Scoring on their own studies' Insights page,
    // same as Admin; they still can't approve a priority score elsewhere in
    // the app (no such action exists on this role's other screens anyway).
    perm('priorityScoring', { read: true, create: true }),
    perm('reportsDashboards', { read: true, export: true }),
    // Read-only Archive + able to request cross-org Sharing access (the
    // owning org's admin still has to approve — see SharingService.decide).
    perm('archiveSharingAudit', { read: true, create: true }),
    // Read-only — curating suggested questions (add from Question Bank/add
    // custom/remove) and publishing is entirely the Reviewer/Approver's job
    // now (see role_human_reviewer below, which holds `write`+`approve`).
    perm('surveyBuilder', RO),
  ] },
  { id: 'role_field_researcher', key: 'field_researcher', name: 'Field Researcher', description: 'Enters needs and documents the source and field notes.', crossEntity: false, permissions: [
    perm('entityTeam'), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO), perm('studySurvey', RO),
    perm('dataCollection', { read: true, write: true, create: true }),
    perm('dataImport'), perm('citizenChannel'), perm('aiReview'), perm('priorityScoring'),
    perm('reportsDashboards'), perm('archiveSharingAudit'), perm('surveyBuilder'),
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
    // `approve` (not `write`) — this role's entire job is deciding on an
    // AI classification once it's ready for review (Approve/Override/Reject
    // — see AiDecisionsService.approveAiReview/rejectAiReview), now a single
    // merged step with Survey approval on the Need workspace page. They
    // never trigger classification/Retry themselves (no `write`) — that's
    // the Researcher's own action (see role_ngo_research_officer above).
    perm('aiReview', { read: true, approve: true }),
    perm('priorityScoring', RO),
    // Reviewer's work starts at Studies/Reviewer-SLA, not an executive
    // dashboard, but they still need read access to Reports/Archive/Sharing
    // once a study's classification/review work is done.
    perm('reportsDashboards', RO), perm('archiveSharingAudit', RO),
    // `write` — curating the suggested question list (add from Question
    // Bank/add custom/remove/reorder) is this role's own job now, alongside
    // `approve` (which covers Approve/Override/Reject — see
    // AiDecisionsService.approveAiReview/rejectAiReview — and legacy
    // Survey approve/reject/publish via SurveysService).
    perm('surveyBuilder', { read: true, write: true, approve: true }),
  ] },
  { id: 'role_data_analyst', key: 'data_analyst', name: 'Data Analyst', description: 'Processes data, reviews quality, and prepares reports and dashboards.', crossEntity: false, permissions: [
    perm('entityTeam'), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO), perm('studySurvey', RO), perm('dataCollection', RO),
    perm('dataImport', { read: true, write: true, create: true }), perm('citizenChannel'),
    perm('aiReview', RO),
    perm('priorityScoring', { read: true, write: true, create: true, approve: true, export: true }),
    perm('reportsDashboards', { read: true, write: true, create: true, export: true }),
    perm('archiveSharingAudit', RO), perm('surveyBuilder'),
  ] },
  { id: 'role_system_admin', key: 'system_admin', name: 'System Admin', description: 'Manages accounts, roles, permissions, audit log, and configuration settings.', crossEntity: true, permissions: [
    perm('entityTeam', { read: true, write: true, create: true, export: true }),
    perm('rolesPermissions', RO), perm('onboardingConsent', RO), perm('methodologyQuestionBank', RO),
    perm('studySurvey', RO), perm('dataCollection', RO), perm('dataImport', RO), perm('citizenChannel', RO),
    perm('aiReview', RO), perm('priorityScoring', RO), perm('reportsDashboards', RO), perm('archiveSharingAudit', RO),
    perm('surveyBuilder'),
  ] },
  { id: 'role_read_only_viewer', key: 'read_only_viewer', name: 'Read-only Viewer', description: 'Views authorized outputs without editing.', crossEntity: false, permissions: [
    perm('entityTeam'), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO), perm('studySurvey', RO), perm('dataCollection', RO),
    perm('dataImport', RO), perm('citizenChannel'), perm('aiReview', RO), perm('priorityScoring', RO),
    perm('reportsDashboards', { read: true, export: true }), perm('archiveSharingAudit', RO), perm('surveyBuilder'),
  ] },
  { id: 'role_center_supervisor', key: 'center_supervisor', name: 'Center Supervisor', description: 'Cross-entity supervisory authority to follow studies, data, and reports for quality.', crossEntity: true, permissions: [
    perm('entityTeam', RO), perm('rolesPermissions'), perm('onboardingConsent'),
    perm('methodologyQuestionBank', RO), perm('studySurvey', RO), perm('dataCollection', RO),
    perm('dataImport', RO), perm('citizenChannel'), perm('aiReview', RO), perm('priorityScoring', RO),
    perm('reportsDashboards', { read: true, export: true }), perm('archiveSharingAudit', RO), perm('surveyBuilder'),
  ] },
  { id: 'role_citizen_guest', key: 'citizen_guest', name: 'Citizen / Beneficiary Guest', description: 'Submits a need as a data source via OTP; not added before human review.', crossEntity: false,
    permissions: PERMISSION_MODULES.map((m) => (m === 'citizenChannel' ? perm(m, { create: true }) : perm(m))) },
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
