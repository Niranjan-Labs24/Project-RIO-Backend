/**
 * RIO-DATA-001 — the separately-versioned consents. `use_policy` is the
 * acceptance of the platform's terms of use; `data_sharing` is the distinct
 * consent to share the organisation's data. They version independently, so
 * an org can be current on one and stale on the other.
 *
 * `citizen_consent` is the notice a citizen respondent accepts before a
 * public survey collects anything (RIO-NFR-002). It shares this vocabulary
 * because it shares the whole lifecycle — drafted by a System Admin, approved
 * by a System Reviewer, published, versioned — but not the audience: it is
 * never shown at signup, and its acceptance is recorded on the SurveyResponse
 * rather than as a ConsentAcceptance, since a citizen has no account.
 */
export const CONSENT_KINDS = ['use_policy', 'data_sharing', 'citizen_consent'] as const;
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

/**
 * Where a version sits in the draft → review → publish workflow the client
 * confirmed on 2026-08-27. Mirrors `MethodologyStatus` deliberately: same
 * governance gate, same vocabulary, so the two admin screens read alike.
 */
export const CONSENT_POLICY_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'published',
] as const;
export type ConsentPolicyStatus = (typeof CONSENT_POLICY_STATUSES)[number];

/**
 * One consent policy version as the Methodology Configuration admin tab sees
 * it — the full row including workflow state and provenance, unlike
 * `ActiveConsentPolicy` which is the anonymous signup screen's minimal view
 * (text + version only, and only ever of the live version).
 */
export interface ConsentPolicyVersion {
  id: string;
  kind: ConsentKind;
  version: string;
  text: string;
  textAr: string | null;
  status: ConsentPolicyStatus;
  /** True for the one version per kind currently shown at signup. */
  active: boolean;
  createdByName: string | null;
  createdAt: string;
  updatedByName: string | null;
  updatedAt: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  publishedByName: string | null;
  publishedAt: string | null;
}

/** Every version of every kind, newest first — the admin tab's whole payload. */
export interface ConsentPolicyVersionList {
  usePolicy: ConsentPolicyVersion[];
  dataSharing: ConsentPolicyVersion[];
  citizenConsent: ConsentPolicyVersion[];
}

export interface CreateConsentPolicyPayload {
  kind: ConsentKind;
  version: string;
  text: string;
  textAr?: string | null;
}

export interface UpdateConsentPolicyPayload {
  version?: string;
  text?: string;
  textAr?: string | null;
}

/**
 * Human-readable name per kind — used in audit entity labels and in the
 * "no active policy" error. Centralised so a new kind cannot be added
 * without naming it (the Record type makes omission a compile error), which
 * is exactly how `citizen_consent` would otherwise have shipped labelled
 * "Data Sharing Policy" by a two-branch ternary.
 */
export const CONSENT_KIND_LABEL: Record<ConsentKind, string> = {
  use_policy: 'Terms of Use',
  data_sharing: 'Data Sharing Policy',
  citizen_consent: 'Citizen Consent',
};
