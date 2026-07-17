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
    },
    { additionalProperties: false },
  ),
);
export type SignupDto = Static<typeof SignupBody>;

export const ChangePasswordBody = registerSchema(
  'ChangePasswordBody',
  T.Object(
    {
      currentPassword: T.String({ minLength: 1, maxLength: 200 }),
      newPassword: T.String({ minLength: 8, maxLength: 200 }),
    },
    { additionalProperties: false },
  ),
);
export type ChangePasswordDto = Static<typeof ChangePasswordBody>;
