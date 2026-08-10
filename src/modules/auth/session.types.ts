import type { RoleDef } from '../../rbac/role-matrix';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  consentedAt: string | null;
  // The policy version `consentedAt` corresponds to — compared against the
  // currently-active policy's version (GET /consent-policy/active) to decide
  // whether ConsentGuard should re-prompt (e.g. after a policy version bump).
  consentedPolicyVersion: string | null;
}

export interface SessionOrg {
  id: string;
  name: string;
  logoUrl: string | null;
  region: string[];
  email: string | null;
  sector: string | null;
  villages: string[];
  regionId: string | null;
  governorateIds: string[];
  centerIds: string[];
  isActive: boolean;
  createdAt: string;
  purpose: string | null;
  registrationNumber: string | null;
}

// role matches the FE AuthRole ({id,key,name,crossEntity,permissions}); RoleDef
// is a superset (also carries description) — harmless extra field.
export interface SessionContext {
  token: string;
  user: SessionUser;
  organization: SessionOrg;
  role: RoleDef;
  mustChangePassword: boolean;
}

/** signup's response — SessionContext plus how the temp password was delivered.
 * No longer returned by AuthService.signup() itself (see SignupPendingApprovalView
 * below) — kept for the shape a login *after* approval still produces. */
export interface SignupResponseView extends SessionContext {
  temporaryPasswordEmailed: boolean;
  temporaryPassword?: string;
}

/**
 * RIO-FR-010 (client-confirmed): self-registration requires Center (System
 * Admin) approval before activation — no session is established at signup
 * time. The entity's admin logs in normally via POST /auth/login once
 * approved and the temporary password has been issued (see
 * OrganizationsService.approve).
 */
export interface SignupPendingApprovalView {
  status: 'pending_approval';
  organizationName: string;
  email: string;
}
