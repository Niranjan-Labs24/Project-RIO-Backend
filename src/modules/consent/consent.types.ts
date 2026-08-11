/**
 * RIO-DATA-001 — the two separately-versioned consents. `use_policy` is the
 * acceptance of the platform's terms of use; `data_sharing` is the distinct
 * consent to share the organisation's data. They version independently, so
 * an org can be current on one and stale on the other.
 */
export const CONSENT_KINDS = ['use_policy', 'data_sharing'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

export interface ActiveConsentPolicy {
  kind: ConsentKind;
  version: string;
  text: string;
}

/**
 * Both active policies in one payload. The signup screen needs both before
 * the caller has any session at all, and fetching them together keeps the
 * registration form from rendering one checkbox before the other.
 */
export interface ActiveConsentPolicies {
  usePolicy: ActiveConsentPolicy;
  dataSharing: ActiveConsentPolicy;
}

/** One consent's acceptance state, as shown on Organization Settings. */
export interface ConsentAcceptanceStatus {
  version: string | null;
  acceptedAt: string | null;
}

// Read-only view for Organization Settings' Consent card — the org owner's
// acceptance of each consent, or all-null fields if they haven't accepted
// that one yet (e.g. an account created before the sharing consent existed).
export interface OrganizationConsentStatus {
  usePolicy: ConsentAcceptanceStatus;
  dataSharing: ConsentAcceptanceStatus;
  acceptedByName: string | null;
  acceptedByEmail: string | null;
}
