import { ROLE_MATRIX, LOGIN_ROLE_KEYS, can } from './role-matrix';

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

  it('ncnp_user is cross-entity but has no permission on any other module', () => {
    const role = ROLE_MATRIX.find((r) => r.key === 'ncnp_user');
    expect(role?.id).toBe('role_ncnp_user');
    expect(role?.crossEntity).toBe(true);
    expect(role?.permissions.every((p) => !p.read && !p.write && !p.create && !p.approve && !p.export && !p.share)).toBe(true);
  });

  it('ngo_admin has full access; can() reflects the matrix', () => {
    expect(can('ngo_admin', 'archiveSharingAudit', 'share')).toBe(true);
    expect(can('system_admin', 'entityTeam', 'create')).toBe(true);
    expect(can('system_admin', 'studySurvey', 'write')).toBe(false); // reads all, writes only accounts/orgs/config
    // AI classification/Approve/Override/Reject (see
    // AiDecisionsService.approveAiReview/rejectAiReview) is full parity
    // between both roles now — a deliberate product decision that the
    // Approver is no longer a mandatory second reviewer for classification
    // specifically. Only the Researcher can trigger classification/Retry
    // itself (`write`) — the Approver never does. Curating the survey's
    // question list (Domain/Sub-domain select, add from Question Bank,
    // add/remove custom questions) is shared `write` between both roles
    // too; only the Approver holds surveyBuilder `approve` (Survey
    // Approve & Publish / Reject stays Approver-exclusive).
    expect(can('human_reviewer', 'aiReview', 'approve')).toBe(true);
    expect(can('human_reviewer', 'aiReview', 'write')).toBe(false);
    expect(can('ngo_research_officer', 'aiReview', 'approve')).toBe(true);
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
});
