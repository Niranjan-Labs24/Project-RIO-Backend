export interface OrgUserRole {
  id: string;
  key: string;
  name: string;
}

export interface OrgUser {
  id: string;
  name: string;
  email: string;
  /** RIO MFA — null when this user hasn't supplied one (no OTP-over-SMS sign-in). */
  mobileNumber: string | null;
  role: OrgUserRole;
  status: 'active' | 'invited' | 'disabled';
  createdAt: string;
}

export interface InviteUserPayload {
  name: string;
  email: string;
  roleId: string;
  /** RIO MFA — optional at invite time; enables "Sign in with OTP" for this user. */
  mobileNumber?: string;
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
  /** RIO MFA — set/change/clear ('' clears it) an existing user's mobile number. */
  mobileNumber?: string;
}

// System-Admin cross-org create.
export interface CreateForOrgPayload extends InviteUserPayload {
  organizationId: string;
}

export interface AssignNgoAdminPayload {
  userId?: string;
  name?: string;
  email?: string;
  reason?: string;
}

export interface UpdateUserRolePayload {
  roleId: string;
  reason?: string;
}

export interface UpdateUserStatusPayload {
  status: 'active' | 'invited' | 'disabled';
  reason?: string;
}

export interface UserRow {
  id: string;
  orgId: string;
  name: string;
  email: string;
  mobileNumber?: string | null;
  roleId: string;
  status: 'active' | 'invited' | 'disabled';
  createdAt: Date;
}
