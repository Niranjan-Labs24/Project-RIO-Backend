export interface Organization {
  id: string;
  name: string;
  // Captured at public signup (see AuthService.signup()) — immutable
  // thereafter; not part of UpdateOrganizationPayload.
  purpose: string;
  registrationNumber: string;
  logoUrl: string | null;
  region: string | null;
  email: string | null;
  sector: string | null;
  villages: string[];
  isActive: boolean;
  createdAt: string;
}

export interface OrganizationSummary extends Organization {
  memberCount: number;
}

export interface UpdateOrganizationPayload {
  name?: string;
  region?: string | null;
  email?: string | null;
  sector?: string | null;
  logoUrl?: string | null;
  villages?: string[];
  isActive?: boolean;
}

export interface CreateOrganizationPayload {
  name: string;
  purpose: string;
  registrationNumber: string;
  region?: string | null;
  email?: string | null;
  sector?: string | null;
  villages?: string[];
  adminName: string;
  adminEmail: string;
}

// Shape of an organisations row as this module reads it.
export interface OrgRow {
  id: string;
  name: string;
  purpose: string;
  registrationNumber: string;
  logoUrl: string | null;
  region: string | null;
  email: string | null;
  sector: string | null;
  villages: string[];
  isActive: boolean;
  createdAt: Date;
}
