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

/** signup's response — SessionContext plus how the temp password was delivered. */
export interface SignupResponseView extends SessionContext {
  temporaryPasswordEmailed: boolean;
  temporaryPassword?: string;
}
