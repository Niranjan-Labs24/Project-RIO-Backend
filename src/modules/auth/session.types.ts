import type { RoleDef } from '../../rbac/role-matrix';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  consentedAt: string | null;
}

export interface SessionOrg {
  id: string;
  name: string;
  logoUrl: string | null;
  region: string | null;
  email: string | null;
  sector: string | null;
  villages: string[];
  isActive: boolean;
  createdAt: string;
}

// role matches the FE AuthRole ({id,key,name,crossEntity,permissions}); RoleDef
// is a superset (also carries description) — harmless extra field.
export interface SessionContext {
  token: string;
  user: SessionUser;
  organization: SessionOrg;
  role: RoleDef;
}
