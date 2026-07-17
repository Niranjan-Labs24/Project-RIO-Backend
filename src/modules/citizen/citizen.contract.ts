import { registerSchema, T, type Static } from '../../contract/typebox';

// `contact` is deliberately a single provider-agnostic string (email today,
// phone later) — see RIO-FR-Add-02 and MailerService.sendOtpCode.
export const RequestOtpBody = registerSchema(
  'RequestOtpBody',
  T.Object(
    { contact: T.String({ minLength: 3, maxLength: 320 }) },
    { additionalProperties: false },
  ),
);
export type RequestOtpDto = Static<typeof RequestOtpBody>;

export const CheckDuplicateBody = registerSchema(
  'CheckDuplicateBody',
  T.Object(
    { contact: T.String({ minLength: 3, maxLength: 320 }) },
    { additionalProperties: false },
  ),
);
export type CheckDuplicateDto = Static<typeof CheckDuplicateBody>;

export const VerifyOtpBody = registerSchema(
  'VerifyOtpBody',
  T.Object(
    {
      challengeId: T.String({ format: 'uuid' }),
      code: T.String({ minLength: 4, maxLength: 8 }),
    },
    { additionalProperties: false },
  ),
);
export type VerifyOtpDto = Static<typeof VerifyOtpBody>;

export const SubmitResponseBody = registerSchema(
  'SubmitResponseBody',
  T.Object(
    {
      challengeId: T.String({ format: 'uuid' }),
      contactName: T.Optional(T.String({ maxLength: 200 })),
      answers: T.Record(T.String(), T.Unknown()),
    },
    { additionalProperties: false },
  ),
);
export type SubmitResponseDto = Static<typeof SubmitResponseBody>;
