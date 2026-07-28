import { ROLE_MATRIX, LOGIN_ROLE_KEYS, can } from './role-matrix';

describe('ROLE_MATRIX', () => {
  it('has the 9 roles with FE-matching ids/keys', () => {
    expect(ROLE_MATRIX).toHaveLength(9);
    expect(ROLE_MATRIX.find((r) => r.key === 'ngo_admin')?.id).toBe('role_ngo_admin');
    expect(ROLE_MATRIX.find((r) => r.key === 'system_admin')?.crossEntity).toBe(true);
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
    expect(LOGIN_ROLE_KEYS).toHaveLength(8);
  });
});
