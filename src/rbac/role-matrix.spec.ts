import { ROLE_MATRIX, LOGIN_ROLE_KEYS, PERMISSION_MODULES, can } from './role-matrix';

describe('ROLE_MATRIX', () => {
  // Relationship assertions rather than a hardcoded total — adding another
  // role later shouldn't break this test just because the count moved.
  it('has FE-matching ids/keys for the roles it does contain', () => {
    expect(ROLE_MATRIX.find((r) => r.key === 'ngo_admin')?.id).toBe('role_ngo_admin');
    expect(ROLE_MATRIX.find((r) => r.key === 'system_admin')?.crossEntity).toBe(true);
  });

  it('system_reviewer reviews the NCNP Compiled Report only — cross-entity, read-only everywhere else', () => {
    const role = ROLE_MATRIX.find((r) => r.key === 'system_reviewer');
    expect(role?.id).toBe('role_system_reviewer');
    expect(role?.crossEntity).toBe(true);
    expect(can('system_reviewer', 'ncnpReport', 'read')).toBe(true);
    expect(can('system_reviewer', 'ncnpReport', 'approve')).toBe(true);
    // Cannot generate/publish (that's System Admin's `write`, not held here).
    expect(can('system_reviewer', 'ncnpReport', 'write')).toBe(false);
    // Read-only on Needs/Surveys/Documents; no approve/write/create anywhere.
    expect(can('system_reviewer', 'studySurvey', 'read')).toBe(true);
    expect(can('system_reviewer', 'dataCollection', 'read')).toBe(true);
    expect(can('system_reviewer', 'dataImport', 'read')).toBe(true);
    expect(can('system_reviewer', 'surveyBuilder', 'approve')).toBe(false);
    expect(can('system_reviewer', 'surveyBuilder', 'write')).toBe(false);
    // Documents (the client's "Documents" menu, reusing the RPT01-14
    // Reports module): view + download, no approve/write.
    expect(can('system_reviewer', 'reportsDashboards', 'read')).toBe(true);
    expect(can('system_reviewer', 'reportsDashboards', 'export')).toBe(true);
    expect(can('system_reviewer', 'reportsDashboards', 'write')).toBe(false);
    expect(can('system_reviewer', 'reportsDashboards', 'approve')).toBe(false);
    // No Administration/Audit access at all.
    expect(can('system_reviewer', 'entityTeam', 'read')).toBe(false);
    expect(can('system_reviewer', 'rolesPermissions', 'read')).toBe(false);
    expect(can('system_reviewer', 'archiveSharingAudit', 'read')).toBe(false);
  });

  it('system_admin can generate and publish the NCNP Compiled Report, not approve/reject it', () => {
    expect(can('system_admin', 'ncnpReport', 'read')).toBe(true);
    expect(can('system_admin', 'ncnpReport', 'write')).toBe(true);
    expect(can('system_admin', 'ncnpReport', 'approve')).toBe(false);
  });

  // RIO-FR-007 — the BRD names System Admin as the role that "manages ... the
  // audit log", so read-alone was a gap: it could open the log but never
  // download it. `export` is the exact action GET /audit/export is gated on.
  it('system_admin can read AND export the audit log, without gaining Archive/Sharing writes', () => {
    expect(can('system_admin', 'archiveSharingAudit', 'read')).toBe(true);
    expect(can('system_admin', 'archiveSharingAudit', 'export')).toBe(true);
    // Same module, but export must not have widened anything else: Sharing's
    // request/decide actions and Archive writes stay out of reach.
    expect(can('system_admin', 'archiveSharingAudit', 'create')).toBe(false);
    expect(can('system_admin', 'archiveSharingAudit', 'write')).toBe(false);
    expect(can('system_admin', 'archiveSharingAudit', 'approve')).toBe(false);
    expect(can('system_admin', 'archiveSharingAudit', 'share')).toBe(false);
  });

  // Roles the status review lists as audit-log read-only must stay read-only —
  // the FR-007 export grant is System Admin's alone (plus ngo_admin's blanket
  // full access, asserted separately below).
  it('audit-log export stays exclusive to system_admin and ngo_admin', () => {
    for (const key of ['human_reviewer', 'data_analyst', 'read_only_viewer', 'center_supervisor', 'ngo_research_officer']) {
      expect(can(key, 'archiveSharingAudit', 'export')).toBe(false);
    }
    // No audit access whatsoever for these two.
    expect(can('field_researcher', 'archiveSharingAudit', 'read')).toBe(false);
    expect(can('system_reviewer', 'archiveSharingAudit', 'read')).toBe(false);
  });

  // RIO-RBAC-001 (client-confirmed): "Center supervisor / NCNP supervisor"
  // is one combined role, not two — the old separate `ncnp_user` role is
  // retired; `center_supervisor` now covers both.
  it('center_supervisor (NCNP Supervisor) is cross-entity, read-only everywhere, and can view the NCNP Compiled Report', () => {
    const role = ROLE_MATRIX.find((r) => r.key === 'center_supervisor');
    expect(role?.id).toBe('role_center_supervisor');
    expect(role?.crossEntity).toBe(true);
    expect(role?.permissions.every((p) => !p.write && !p.create && !p.approve && !p.share)).toBe(true);
    // archiveSharingAudit:read is what the NCNP Compiled Report controller
    // actually gates on (see ncnp-report.controller.ts) — without this the
    // old ncnp_user role could never reach its own report.
    expect(can('center_supervisor', 'archiveSharingAudit', 'read')).toBe(true);
    expect(ROLE_MATRIX.find((r) => r.key === 'ncnp_user')).toBeUndefined();
  });

  it('ngo_admin has full access; can() reflects the matrix', () => {
    expect(can('ngo_admin', 'archiveSharingAudit', 'share')).toBe(true);
    expect(can('system_admin', 'entityTeam', 'create')).toBe(true);
    expect(can('system_admin', 'studySurvey', 'write')).toBe(false); // reads all, writes only accounts/orgs/config
    // AI classification/Approve/Override/Reject (see
    // AiDecisionsService.approveAiReview/rejectAiReview) is Reviewer-exclusive
    // per the client's Roles & Permissions sheet — Researcher can trigger
    // classification/Retry (`write`) but does not approve it. Curating the
    // survey's question list (Domain/Sub-domain select, add from Question
    // Bank, add/remove custom questions) is shared `write` between both
    // roles; only the Approver holds surveyBuilder `approve` (Survey
    // Approve & Publish / Reject stays Approver-exclusive).
    expect(can('human_reviewer', 'aiReview', 'approve')).toBe(true);
    expect(can('human_reviewer', 'aiReview', 'write')).toBe(false);
    expect(can('ngo_research_officer', 'aiReview', 'approve')).toBe(false);
    expect(can('ngo_research_officer', 'aiReview', 'write')).toBe(true);
    expect(can('ngo_research_officer', 'surveyBuilder', 'write')).toBe(true);
    expect(can('ngo_research_officer', 'surveyBuilder', 'approve')).toBe(false);
    expect(can('human_reviewer', 'surveyBuilder', 'write')).toBe(true);
    expect(can('human_reviewer', 'surveyBuilder', 'approve')).toBe(true);
    expect(can('ngo_research_officer', 'rolesPermissions', 'read')).toBe(false);
    expect(can(undefined, 'entityTeam', 'read')).toBe(false); // no role → deny
  });

  it('excludes citizen_guest from login-capable roles', () => {
    expect(LOGIN_ROLE_KEYS).not.toContain('citizen_guest');
    // Derived from the exclusion rule itself, not a hardcoded number — every
    // role except citizen_guest is login-capable, whatever the total is.
    expect(LOGIN_ROLE_KEYS).toHaveLength(ROLE_MATRIX.length - 1);
  });

  it('approver can approve/reject/archive a report, not just read/export it', () => {
    // Regression: this role previously had only { read, export } on
    // reportsDashboards, which silently blocked ReportsController's
    // :id/approve, :id/reject, and :id/archive (all gated on `approve`) —
    // the Approver could view and export a report but never actually
    // release, reject, or archive one, defeating the two-step
    // Officer-confirms/Approver-approves workflow entirely.
    expect(can('human_reviewer', 'reportsDashboards', 'read')).toBe(true);
    expect(can('human_reviewer', 'reportsDashboards', 'export')).toBe(true);
    expect(can('human_reviewer', 'reportsDashboards', 'approve')).toBe(true);
    // Confirming a report (step 1) is the Officer's `write`-gated action,
    // not the Approver's.
    expect(can('human_reviewer', 'reportsDashboards', 'write')).toBe(false);
  });

  it('research officer generates AND confirms their own report; approve stays Approver/NGO-Admin-exclusive', () => {
    // Product decision: generate-then-confirm is one continuous step owned
    // by the Officer, not split across a separate Data Analyst handoff (see
    // role-matrix.ts's reportsDashboards comment on this role).
    expect(can('ngo_research_officer', 'reportsDashboards', 'create')).toBe(true);
    expect(can('ngo_research_officer', 'reportsDashboards', 'write')).toBe(true);
    expect(can('ngo_research_officer', 'reportsDashboards', 'approve')).toBe(false);
  });

  // ──────── RIO-NFR-016 — operational log (systemLogs) ────────

  it('system_admin alone can read and export the operational log', () => {
    expect(can('system_admin', 'systemLogs', 'read')).toBe(true);
    expect(can('system_admin', 'systemLogs', 'export')).toBe(true);
    // There is no HTTP write path to this table, so no write bit to hold.
    expect(can('system_admin', 'systemLogs', 'write')).toBe(false);
    expect(can('system_admin', 'systemLogs', 'create')).toBe(false);
    expect(can('system_admin', 'systemLogs', 'approve')).toBe(false);
  });

  it('no role other than system_admin holds any systemLogs action', () => {
    const others = ROLE_MATRIX.map((r) => r.key).filter((k) => k !== 'system_admin');
    for (const key of others) {
      for (const action of ['read', 'write', 'create', 'approve', 'export', 'share'] as const) {
        expect(can(key, 'systemLogs', action), `${key} must not hold systemLogs:${action}`).toBe(false);
      }
    }
  });

  it('ngo_admin does not inherit systemLogs from the full-access helper', () => {
    // Regression: `fullAccess()` grants every module in PERMISSION_MODULES,
    // so a new non-entity-scoped module silently lands on NGO Admin the
    // moment it is added to that array — the exact bug that hit ncnpReport.
    // NON_ENTITY_MODULES is the exclusion list that stops it.
    expect(can('ngo_admin', 'systemLogs', 'read')).toBe(false);
    expect(can('ngo_admin', 'systemLogs', 'export')).toBe(false);
    // NGO Admin still holds full access to every entity-scoped module.
    expect(can('ngo_admin', 'studySurvey', 'write')).toBe(true);
    expect(can('ngo_admin', 'archiveSharingAudit', 'export')).toBe(true);
  });

  it('adding systemLogs did not disturb any audit-log grant', () => {
    // The whole point of a separate module: audit (RIO-FR-007) access is
    // unchanged by operational-log (RIO-NFR-016) access, in both directions.
    expect(can('system_admin', 'archiveSharingAudit', 'read')).toBe(true);
    expect(can('system_admin', 'archiveSharingAudit', 'export')).toBe(true);
    expect(can('center_supervisor', 'archiveSharingAudit', 'read')).toBe(true);
    expect(can('center_supervisor', 'systemLogs', 'read')).toBe(false);
    expect(can('data_analyst', 'archiveSharingAudit', 'read')).toBe(true);
    expect(can('data_analyst', 'systemLogs', 'read')).toBe(false);
  });

  it('lists systemLogs as a real module so the FE type stays in sync', () => {
    expect(PERMISSION_MODULES).toContain('systemLogs');
  });
});
