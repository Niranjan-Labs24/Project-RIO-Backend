import { registerSchema, T, type Static } from '../../contract/typebox';

/**
 * Deliberately not `format: 'email'` — the controller trims/lowercases
 * before calling AuthService.login(), and login's own failure path already
 * returns a generic 401 for any bad credential shape, so tightening this to
 * a strict email format risks rejecting input the manual presence check
 * (`!email || !password`) this replaces used to accept. `maxLength: 320`
 * mirrors RFC 5321's email length ceiling as a DoS/oversized-payload bound,
 * not a format constraint.
 */
export const LoginBody = registerSchema(
  'LoginBody',
  T.Object(
    {
      email: T.String({ minLength: 1, maxLength: 320 }),
      password: T.String({ minLength: 1, maxLength: 200 }),
    },
    { additionalProperties: false },
  ),
);
export type LoginDto = Static<typeof LoginBody>;

/**
 * RIO MFA — "Sign in with OTP". `identifier` is either the account's email
 * or its mobile number, exactly as the login form's single input accepts
 * either; AuthService.requestLoginOtp decides which channel to use by
 * matching it against the stored email/mobileNumber. Same generic-response
 * posture as ForgotPasswordBody: a non-existent or OTP-ineligible account
 * gets the same reply as a real one, so this endpoint cannot be used to
 * enumerate accounts.
 */
export const RequestLoginOtpBody = registerSchema(
  'RequestLoginOtpBody',
  T.Object(
    { identifier: T.String({ minLength: 1, maxLength: 320 }) },
    { additionalProperties: false },
  ),
);
export type RequestLoginOtpDto = Static<typeof RequestLoginOtpBody>;

/**
 * Verifies the code and, on success, issues a session exactly like
 * POST /auth/login. `identifier` is resent rather than a challengeId — see
 * AuthService.verifyLoginOtp — so a client never holds a value that itself
 * confirms an account exists.
 */
export const VerifyLoginOtpBody = registerSchema(
  'VerifyLoginOtpBody',
  T.Object(
    {
      identifier: T.String({ minLength: 1, maxLength: 320 }),
      code: T.String({ minLength: 4, maxLength: 8 }),
    },
    { additionalProperties: false },
  ),
);
export type VerifyLoginOtpDto = Static<typeof VerifyLoginOtpBody>;

// Not a fixed enum: `sector` is validated against the live, active Domain
// list from Methodology Configuration (see AuthService.signup —
// DomainsService.listDomains()), or the literal "other". Mirrors
// organizations.contract.ts's own SectorValue.
const SectorValue = T.String({ minLength: 1, maxLength: 200 });

// The language a consent was rendered in. A closed union rather than a free
// string: the value ends up on an immutable acceptance record describing what
// the user read, so an unrecognised locale is a lie the schema can prevent.
// Kept in step with CONSENT_LOCALES (consent.types.ts) and, in turn, the
// frontend's routing.locales.
const ConsentLocaleValue = T.Union([T.Literal('en'), T.Literal('ar')]);

/**
 * RIO-DATA-001 — the two consents the registrant must accept, submitted as
 * the exact policy version each checkbox was shown for, not as a bare
 * boolean. A boolean would record "they ticked something" without pinning
 * *what*; the version makes the acceptance verifiable and lets the server
 * reject a form that was left open across a policy update (see
 * AuthService.signup's active-version check). Both are required: registration
 * cannot complete without accepting both.
 */
const ConsentAcceptanceBody = T.Object(
  {
    usePolicyVersion: T.String({ minLength: 1, maxLength: 64 }),
    dataSharingVersion: T.String({ minLength: 1, maxLength: 64 }),
    // Which language the two policies were rendered in, for the same reason
    // the version is sent: it pins *what* was agreed to. Once a policy exists
    // in English and Arabic, the version alone no longer identifies the
    // wording a registrant read, and the acceptance snapshot would be filed
    // against text they never saw.
    //
    // Optional so a client that predates the Arabic copy keeps working — an
    // omitted locale means English, which is what such a client necessarily
    // displayed. Not trusted as text either: the server re-derives the
    // wording from this locale (see resolveSignupConsents), so the client
    // chooses a language, never the policy content.
    locale: T.Optional(ConsentLocaleValue),
  },
  { additionalProperties: false },
);

/**
 * Public signup — no password/adminName fields: the email IS the NGO Admin
 * account and the server issues a temporary password (see AuthService.signup).
 *
 * Consent IS collected here (RIO-DATA-001): both the use policy and the
 * data-sharing consent are accepted as part of registration itself, in the
 * same transaction that creates the org — registration cannot complete
 * without them. AuthService.consent() still exists, but now only serves
 * accounts predating this change and re-prompts after a policy version bump.
 *
 * `sector` replaces the old free-text "area of work" field on this form —
 * `purpose` is now only used to carry the reviewer's own text when
 * `sector: 'other'` is picked (matches Settings > Organization's own
 * sector/"specify other" pattern), so it's optional here.
 */
export const SignupBody = registerSchema(
  'SignupBody',
  T.Object(
    {
      organizationName: T.String({ minLength: 1, maxLength: 200 }),
      sector: T.Optional(SectorValue),
      purpose: T.Optional(T.String({ maxLength: 500 })),
      registrationNumber: T.String({ minLength: 1, maxLength: 100 }),
      email: T.String({ format: 'email' }),
      // RIO MFA — optional mobile number for the first NGO Admin, so their
      // account is eligible for "Sign in with OTP" over SMS from day one.
      // Loosely bounded (not a strict E.164 pattern): AuthService.signup
      // normalizes it the same way CitizenService.normalizeMobile() does.
      mobileNumber: T.Optional(T.String({ maxLength: 32 })),
      // Required, not optional — a signup payload without it is a 400 from
      // the validation pipe before any org row is created.
      consent: ConsentAcceptanceBody,
      // KSA Geographic Reference hierarchy — mandatory at signup so every
      // self-service org starts with its scope already configured (see
      // AuthService.signup for the existence/hierarchy checks TypeBox can't
      // express). Still editable later via Settings > Organization.
      regionId: T.String({ format: 'uuid' }),
      governorateIds: T.Array(T.String({ format: 'uuid' }), { minItems: 1, maxItems: 150 }),
      centerIds: T.Array(T.String({ format: 'uuid' }), { minItems: 1, maxItems: 1404 }),
    },
    { additionalProperties: false },
  ),
);
export type SignupDto = Static<typeof SignupBody>;

/**
 * Body for the post-login consent re-prompt (POST /auth/consent). Carries no
 * versions — unlike signup, this path accepts whatever is active at the
 * moment of the call — but it does carry the locale, for the same reason
 * signup does: the acceptance snapshots the wording shown, and the server
 * cannot otherwise know which language that was.
 *
 * The whole body is optional (see the controller): this endpoint took none
 * before, and an omitted locale means English.
 */
export const ConsentBody = registerSchema(
  'ConsentBody',
  T.Object({ locale: T.Optional(ConsentLocaleValue) }, { additionalProperties: false }),
);
export type ConsentDto = Static<typeof ConsentBody>;

/**
 * The signup form's "Verify" button — checks one registration number against
 * the NIC entity registry without registering anything. Same loose string
 * bound as SignupBody.registrationNumber on purpose: the 10-digit rule is
 * enforced after normalization (Arabic-Indic digits, pasted separators), so a
 * pattern here would reject input the service itself accepts.
 */
export const VerifyRegistrationNumberBody = registerSchema(
  'VerifyRegistrationNumberBody',
  T.Object(
    { registrationNumber: T.String({ minLength: 1, maxLength: 100 }) },
    { additionalProperties: false },
  ),
);
export type VerifyRegistrationNumberDto = Static<typeof VerifyRegistrationNumberBody>;

export interface VerifyRegistrationNumberView {
  verified: boolean;
  /** Why it failed, for the frontend to localize. Absent when verified. */
  reason?: 'INVALID_FORMAT' | 'NOT_FOUND';
}

/**
 * Complexity policy for a password the user *sets*: at least 8 characters,
 * with one capital letter, one digit and one special character (anything
 * that isn't a letter, digit or whitespace). Mirrored on the frontend in
 * `src/lib/password-policy.ts` — keep the two in step.
 *
 * `currentPassword` is deliberately exempt: it must still accept the
 * server-issued temporary password, which predates this policy.
 */
const NewPassword = T.String({
  minLength: 8,
  maxLength: 200,
  pattern: '^(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9\\s]).{8,}$',
});

export const ChangePasswordBody = registerSchema(
  'ChangePasswordBody',
  T.Object(
    {
      currentPassword: T.String({ minLength: 1, maxLength: 200 }),
      newPassword: NewPassword,
    },
    { additionalProperties: false },
  ),
);
export type ChangePasswordDto = Static<typeof ChangePasswordBody>;

export const ForgotPasswordBody = registerSchema(
  'ForgotPasswordBody',
  T.Object({ email: T.String({ format: 'email' }) }, { additionalProperties: false }),
);
export type ForgotPasswordDto = Static<typeof ForgotPasswordBody>;

export const ResetPasswordBody = registerSchema(
  'ResetPasswordBody',
  T.Object(
    {
      token: T.String({ minLength: 1, maxLength: 500 }),
      password: NewPassword,
    },
    { additionalProperties: false },
  ),
);
export type ResetPasswordDto = Static<typeof ResetPasswordBody>;
