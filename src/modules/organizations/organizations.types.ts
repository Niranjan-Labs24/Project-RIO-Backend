export interface Organization {
  id: string;
  name: string;
  // Only meaningful when `sector` is `'other'` — the org's own free-text
  // description of what that is. Otherwise unused; nullable because the
  // underlying column is (`String?`).
  purpose: string | null;
  registrationNumber: string | null;
  logoUrl: string | null;
  region: string[];
  email: string | null;
  sector: string | null;
  villages: string[];
  // Optional link into the KSA Geographic Reference master data — additive
  // alongside the free-text `region`/`villages` above, not a replacement
  // for them. An org has exactly *one* Region (single-select, plain scalar),
  // but can span *many* Governorates and *many* Centers (both many-to-many
  // join tables).
  regionId: string | null;
  governorateIds: string[];
  centerIds: string[];
  isActive: boolean;
  createdAt: string;
}

export interface OrganizationSummary extends Organization {
  memberCount: number;
}

export interface UpdateOrganizationPayload {
  name?: string;
  region?: string[];
  email?: string | null;
  sector?: string | null;
  purpose?: string | null;
  logoUrl?: string | null;
  villages?: string[];
  regionId?: string | null;
  // Replaces the *entire* set when provided (not a merge/append) — see
  // OrganizationsService#updateCurrent.
  governorateIds?: string[];
  centerIds?: string[];
  isActive?: boolean;
}

export interface CreateOrganizationPayload {
  name: string;
  purpose: string;
  registrationNumber: string;
  region?: string[];
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
  purpose: string | null;
  registrationNumber: string | null;
  logoUrl: string | null;
  region: string[];
  email: string | null;
  sector: string | null;
  villages: string[];
  regionId: string | null;
  governorateIds: string[];
  centerIds: string[];
  isActive: boolean;
  createdAt: Date;
}
