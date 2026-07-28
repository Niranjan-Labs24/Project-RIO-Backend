import { registerSchema, T, type Static } from '../../contract/typebox';

// Both fields are mandatory now (RIO-FR-Add-02 update) — the respondent
// types both an email and a mobile number, but only the mobile number is
// OTP-verified (see SmsService.sendOtpCode); `contact` (email) is captured
// purely as additional contact info and duplicate-check key, never sent a
// code. `contact` keeps its name (not renamed to `email`) to match
// CitizenOtpChallenge/SurveyResponse's own `contact` column — see those
// models' comments.
export const RequestOtpBody = registerSchema(
  'RequestOtpBody',
  T.Object(
    {
      contact: T.String({ format: 'email' }),
      mobile: T.String({ minLength: 3, maxLength: 32 }),
    },
    { additionalProperties: false },
  ),
);
export type RequestOtpDto = Static<typeof RequestOtpBody>;

export const CheckDuplicateBody = registerSchema(
  'CheckDuplicateBody',
  T.Object(
    {
      contact: T.String({ format: 'email' }),
      mobile: T.String({ minLength: 3, maxLength: 32 }),
    },
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

// Self-reported, fixed vocabulary — see the Gender enum in schema.prisma.
// Optional: a respondent may decline to answer.
const Gender = T.Union([
  T.Literal('male'),
  T.Literal('female'),
  T.Literal('other'),
  T.Literal('prefer_not_to_say'),
]);

export const SubmitResponseBody = registerSchema(
  'SubmitResponseBody',
  T.Object(
    {
      challengeId: T.String({ format: 'uuid' }),
      contactName: T.Optional(T.String({ maxLength: 200 })),
      gender: T.Optional(Gender),
      answers: T.Record(T.String(), T.Unknown()),
    },
    { additionalProperties: false },
  ),
);
export type SubmitResponseDto = Static<typeof SubmitResponseBody>;
