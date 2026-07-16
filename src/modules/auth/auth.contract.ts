import { registerSchema, T, type Static } from '../../contract/typebox';

// Mirrors organizations.contract.ts's own SectorEnum (and prisma `Sector`).
const SectorEnum = T.Union([
  T.Literal('education'),
  T.Literal('healthcare'),
  T.Literal('agriculture'),
  T.Literal('wash'),
  T.Literal('livelihoods'),
  T.Literal('disaster_relief'),
  T.Literal('other'),
]);

/**
 * Public signup — no password/adminName fields: the email IS the NGO Admin
 * account and the server issues a temporary password (see AuthService.signup).
 *
 * RIO-FR-Add-02: `consentAccepted` must be the literal `true` — TypeBox
 * rejects any other value (false, missing, non-boolean) as a 400 before this
 * ever reaches the service, so consent is structurally mandatory, not just a
 * value the service happens to record. See AuthRepository.createOrganisationAndAdmin
 * for where the acceptance row (policy version + timestamp) is written.
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
      sector: T.Optional(SectorEnum),
      purpose: T.Optional(T.String({ maxLength: 500 })),
      registrationNumber: T.String({ minLength: 1, maxLength: 100 }),
      email: T.String({ format: 'email' }),
      consentAccepted: T.Literal(true),
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
