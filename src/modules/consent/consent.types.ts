export interface ActiveConsentPolicy {
  version: string;
  text: string;
}

// Read-only view for Organization Settings' Consent card — the org's most
// recent acceptance, or all-null fields if nobody there has consented yet
// (e.g. straight after signup, before first login/password reset).
export interface OrganizationConsentStatus {
  version: string | null;
  acceptedAt: string | null;
  acceptedByName: string | null;
  acceptedByEmail: string | null;
}
