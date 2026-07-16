import { registerSchema, T, type Static } from '../../contract/typebox';

// This body arrives from an unauthenticated page, so the bounds here are the
// only thing standing between a public caller and the mail transport. Every
// field is required and length-capped — there is no session to rate-limit
// against and an unbounded `purpose` would let anyone post arbitrary volume
// into an NGO's inbox.
export const ContactBody = registerSchema(
  'ContactBody',
  T.Object({
    // The picker's value, from GET /contact/organizations. Validated against a
    // real active org in the service — an unknown id is a 404, not a 400.
    organizationId: T.String({ format: 'uuid' }),
    name: T.String({ minLength: 1, maxLength: 200 }),
    // maxLength matches User.email / Organisation.email (VarChar(320)).
    email: T.String({ format: 'email', maxLength: 320 }),
    region: T.String({ minLength: 1, maxLength: 200 }),
    purpose: T.String({ minLength: 1, maxLength: 2000 }),
  }),
);
export type ContactDto = Static<typeof ContactBody>;
