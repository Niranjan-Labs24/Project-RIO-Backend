import { registerSchema, T, type Static } from '../../contract/typebox';
import { CONSENT_KINDS } from './consent.types';

// The policy body is long-form legal text, so the ceilings here are generous
// by design — a Terms of Use runs to thousands of words. They exist to bound
// a runaway payload, not to shape the content: a System Admin who hits one of
// these has written something that does not belong in a consent dialog.
const POLICY_TEXT_MAX = 200_000;

export const CreateConsentPolicyBody = registerSchema(
  'CreateConsentPolicyBody',
  T.Object(
    {
      kind: T.Union(CONSENT_KINDS.map((kind) => T.Literal(kind))),
      // Free text, not a semver pattern: the existing rows are `v1`, and the
      // client has never committed to a numbering scheme. Uniqueness per kind
      // is enforced by the DB (and re-reported as a friendly 409), which is
      // the constraint that actually matters.
      version: T.String({ minLength: 1, maxLength: 64 }),
      text: T.String({ minLength: 1, maxLength: POLICY_TEXT_MAX }),
      // Nullable, not merely optional: a translation can lag its English
      // source (see ConsentPolicy.textAr), and clearing a half-finished
      // Arabic draft back to "not translated yet" has to be expressible.
      textAr: T.Optional(T.Union([T.String({ maxLength: POLICY_TEXT_MAX }), T.Null()])),
    },
    { additionalProperties: false },
  ),
);
export type CreateConsentPolicyDto = Static<typeof CreateConsentPolicyBody>;

export const UpdateConsentPolicyBody = registerSchema(
  'UpdateConsentPolicyBody',
  T.Object(
    {
      version: T.Optional(T.String({ minLength: 1, maxLength: 64 })),
      text: T.Optional(T.String({ minLength: 1, maxLength: POLICY_TEXT_MAX })),
      textAr: T.Optional(T.Union([T.String({ maxLength: POLICY_TEXT_MAX }), T.Null()])),
    },
    { additionalProperties: false },
  ),
);
export type UpdateConsentPolicyDto = Static<typeof UpdateConsentPolicyBody>;

// Reviewer notes are mandatory on both Approve and Reject — same requirement
// and same shape as ApproveMethodologyConfigBody/RejectMethodologyConfigBody.
// Whitespace-only strings pass minLength:1 (it counts raw characters), so the
// service also runs the shared requireNonBlank() trim-check.
export const ReviewConsentPolicyBody = registerSchema(
  'ReviewConsentPolicyBody',
  T.Object({ notes: T.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
);
export type ReviewConsentPolicyDto = Static<typeof ReviewConsentPolicyBody>;
