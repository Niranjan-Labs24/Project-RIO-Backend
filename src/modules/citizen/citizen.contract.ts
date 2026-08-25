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

// Self-reported age bracket, never exact age/DOB — see the AgeBracket enum
// in schema.prisma. Mandatory (unlike Gender): "prefer_not_to_say" is the
// respondent's opt-out, so there's always a value to submit.
const AgeBracket = T.Union([
  T.Literal('age_15_24'),
  T.Literal('age_25_34'),
  T.Literal('age_35_44'),
  T.Literal('age_45_54'),
  T.Literal('age_55_64'),
  T.Literal('age_65_plus'),
  T.Literal('prefer_not_to_say'),
]);

export const SubmitResponseBody = registerSchema(
  'SubmitResponseBody',
  T.Object(
    {
      challengeId: T.String({ format: 'uuid' }),
      contactName: T.Optional(T.String({ maxLength: 200 })),
      gender: T.Optional(Gender),
      ageBracket: AgeBracket,
      answers: T.Record(T.String(), T.Unknown()),
    },
    { additionalProperties: false },
  ),
);
export type SubmitResponseDto = Static<typeof SubmitResponseBody>;

// Response schemas (GAP-08 Phase 0, batch 4) — shape sourced from the
// frontend's ResolvedSurvey/CheckDuplicateResult/RequestOtpResult/
// VerifyOtpResult/SubmitResponseResult
// (Project-RIO-Frontend/src/services/citizen/citizen.types.ts). Verified
// field-for-field against citizen.types.ts (backend) — identical shapes.
const ResolvedSurveyQuestion = T.Object({
  code: T.String(),
  text: T.String(),
  type: T.String(),
  options: T.Optional(T.Array(T.String())),
  required: T.Boolean(),
});

export const ResolvedSurveyView = registerSchema(
  'ResolvedSurveyView',
  T.Object({
    studyId: T.String(),
    title: T.String(),
    version: T.String(),
    studyTitle: T.String(),
    organizationName: T.String(),
    questions: T.Array(ResolvedSurveyQuestion),
    questionCount: T.Number(),
    estimatedMinutes: T.Number(),
  }),
);

export const CheckDuplicateResultView = registerSchema(
  'CheckDuplicateResultView',
  T.Object({
    isDuplicate: T.Boolean(),
  }),
);

export const RequestOtpResultView = registerSchema(
  'RequestOtpResultView',
  T.Object({
    challengeId: T.String(),
    expiresAt: T.String(),
    codeTexted: T.Boolean(),
    // Only present when codeTexted is false and SMS isn't configured
    // (dev/test) — see RequestOtpResult's own comment in citizen.types.ts.
    code: T.Optional(T.String()),
  }),
);

export const VerifyOtpResultView = registerSchema(
  'VerifyOtpResultView',
  T.Object({
    verified: T.Literal(true),
  }),
);

export const SubmitResponseResultView = registerSchema(
  'SubmitResponseResultView',
  T.Object({
    id: T.String(),
    submittedAt: T.String(),
  }),
);
