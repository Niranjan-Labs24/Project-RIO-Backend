/**
 * RIO-DATA-001 — the two separately-versioned consents. `use_policy` is the
 * acceptance of the platform's terms of use; `data_sharing` is the distinct
 * consent to share the organisation's data. They version independently, so
 * an org can be current on one and stale on the other.
 */
export const CONSENT_KINDS = ['use_policy', 'data_sharing'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/**
 * The languages a consent can be *read* in. Deliberately mirrors the
 * frontend's `routing.locales` rather than being open-ended: an acceptance
 * records which of these the user was shown, so a value outside the set would
 * describe a rendering that cannot happen.
 */
export const CONSENT_LOCALES = ['en', 'ar'] as const;
export type ConsentLocale = (typeof CONSENT_LOCALES)[number];
export const DEFAULT_CONSENT_LOCALE: ConsentLocale = 'en';

export interface ActiveConsentPolicy {
  kind: ConsentKind;
  version: string;
  text: string;
  /**
   * The same version's Arabic wording, or null while a translation is still
   * outstanding. Both are sent to the signup screen in one payload so
   * switching language re-renders the open policy dialog without another
   * round-trip (and without the text going blank mid-read).
   */
  textAr: string | null;
}

/**
 * The wording to show — and to snapshot — for a given reader.
 *
 * Falls back to English when the Arabic copy is missing rather than rendering
 * an empty consent: an untranslated policy is a content gap, but a blank one
 * is a broken registration. The caller pairs the returned text with the
 * locale it actually resolved to (see `resolveConsentLocale`), so a fallback
 * is recorded as the English acceptance it really is.
 */
export function consentPolicyTextFor(
  policy: Pick<ActiveConsentPolicy, 'text' | 'textAr'>,
  locale: ConsentLocale,
): string {
  return locale === 'ar' && policy.textAr ? policy.textAr : policy.text;
}

/**
 * The locale a snapshot should claim, which is not always the one requested:
 * asking for Arabic against an untranslated policy yields English text, and
 * labelling that acceptance `ar` would misrepresent what the user read.
 */
export function resolveConsentLocale(
  policy: Pick<ActiveConsentPolicy, 'textAr'>,
  requested: ConsentLocale,
): ConsentLocale {
  return requested === 'ar' && policy.textAr ? 'ar' : DEFAULT_CONSENT_LOCALE;
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
