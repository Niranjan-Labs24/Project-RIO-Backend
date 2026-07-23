import { registerSchema, T, type Static } from '../../contract/typebox';

// Not a fixed enum: `sector` is validated against the live, active Domain
// list from Methodology Configuration (see AuthService.signup —
// DomainsService.listDomains()), or the literal "other". Mirrors
// organizations.contract.ts's own SectorValue.
const SectorValue = T.String({ minLength: 1, maxLength: 200 });

/**
 * Public signup — no password/adminName fields: the email IS the NGO Admin
 * account and the server issues a temporary password (see AuthService.signup).
 *
 * Consent is NOT collected here — it happens after first login, once the
 * temp password has been replaced (see AuthService.consent() /
 * ConsentGuard on the frontend). Signup only creates the org + its first
 * NGO Admin.
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
