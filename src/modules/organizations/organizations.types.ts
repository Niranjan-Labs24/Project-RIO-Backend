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
  // RIO-FR-010 (client-confirmed): null = self-registered, never yet
  // approved by System Admin (Center approval). Always non-null for an org
  // created directly via createWithAdmin, which skips this gate entirely.
  approvedAt: string | null;
  createdAt: string;
}

export interface OrganizationSummary extends Organization {
  memberCount: number;
  studyCount?: number;
  surveyCount?: number;
  reportCount?: number;
  // Subset of `reportCount` whose status is `released` or `archived` — the
  // closest real concept to "published" (there is no `published` value in
  // ReportStatus itself). Powers the System Admin dashboard's "Published
  // Reports" stat, which previously summed unfiltered `reportCount` across
  // every org and so counted drafts/rejected/submitted reports too.
  publishedReportCount?: number;
  // Total SurveyResponse rows submitted under this org — powers the System
  // Admin dashboard's "Responses Collected" stat, which previously had no
  // real data source and always rendered a hardcoded placeholder.
  responseCount?: number;
  ngoAdminName?: string | null;
  ngoAdminEmail?: string | null;
  deactivationReason?: string | null;
}

export interface UpdateOrganizationStatusPayload {
  isActive: boolean;
  reason?: string | null;
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
  purpose?: string | null;
  // Checked against the NIC entity registry (NicRegistryService) and
  // normalized before storage — same gate as public self-signup, so a
  // System-Admin-created org can never carry an unverified/malformed number.
  registrationNumber: string;
  region?: string[];
  email?: string | null;
  sector: string;
  villages?: string[];
  // Required, same as self-signup: this is the org's actual operating
  // geography, not decoration — a System Admin can't create an org that
  // never gets scoped to a Region/Governorate/Center.
  regionId: string;
  governorateIds: string[];
  centerIds: string[];
  adminName?: string;
  adminEmail?: string;
  // RIO MFA — lets the new NGO Admin use "Sign in with OTP" over SMS from
  // day one, same optional field self-signup captures.
  adminMobileNumber?: string;
  // RIO-DATA-001 — required whenever adminName/adminEmail are both given:
  // an NGO Admin created directly by System Admin still needs both consents
  // on record, same as self-signup. See OrganizationsService#createWithAdmin.
  consent?: {
    usePolicyVersion: string;
    dataSharingVersion: string;
    locale?: 'en' | 'ar';
  };
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
  approvedAt: Date | null;
  createdAt: Date;
}
