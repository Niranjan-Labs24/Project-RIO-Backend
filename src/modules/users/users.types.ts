export interface OrgUserRole {
  id: string;
  key: string;
  name: string;
}

export interface OrgUser {
  id: string;
  name: string;
  email: string;
  role: OrgUserRole;
  status: 'active' | 'invited';
  createdAt: string;
}

export interface InviteUserPayload {
  name: string;
  email: string;
  roleId: string;
}

/** Same shape as auth's SignupResponseView — a temporary password is
 * generated the same way a signup-created NGO Admin gets one, emailed if
 * possible, and surfaced back to the caller (dev-only) when it isn't. */
export interface InviteUserResponse extends OrgUser {
  temporaryPasswordEmailed: boolean;
  temporaryPassword?: string;
}

export interface UpdateUserPayload {
  name?: string;
  roleId?: string;
  status?: 'active' | 'invited';
}

// System-Admin cross-org create.
export interface CreateForOrgPayload extends InviteUserPayload {
  organizationId: string;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  roleId: string;
  status: 'active' | 'invited';
  createdAt: Date;
}
