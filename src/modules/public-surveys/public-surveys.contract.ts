import { registerSchema, T, type Static } from '../../contract/typebox';

export const CreateSurveyLinkBody = registerSchema(
  'CreateSurveyLinkBody',
  T.Object(
    {
      // Required, max 150 chars, and must contain at least one non-whitespace
      // character (the `\S` pattern) so an all-whitespace label is rejected
      // here rather than silently becoming "" after the service trims it.
      // Per-Study uniqueness is enforced at the DB level (see the
      // PublicSurveyLink.@@unique([studyId, label]) schema comment) — a
      // TypeBox schema has no notion of "unique within this Study".
      label: T.String({ minLength: 1, maxLength: 150, pattern: '\\S' }),
      // Omitted = no expiry. RIO-NFR-014-style configurability: callers pick
      // the window per link rather than a single hardcoded TTL.
      expiresInDays: T.Optional(T.Integer({ minimum: 1, maximum: 365 })),
    },
    { additionalProperties: false },
  ),
);
export type CreateSurveyLinkDto = Static<typeof CreateSurveyLinkBody>;

export const ShareSurveyLinkEmailBody = registerSchema(
  'ShareSurveyLinkEmailBody',
  T.Object(
    { email: T.String({ format: 'email', maxLength: 320 }) },
    { additionalProperties: false },
  ),
);
export type ShareSurveyLinkEmailDto = Static<typeof ShareSurveyLinkEmailBody>;

// Response schemas (GAP-08 Phase 0, batch 4) — shape sourced from the
// frontend's PublicSurveyLink/SurveyResponseListResult/SurveyResponseDetail/
// QuestionResponseListResult
// (Project-RIO-Frontend/src/services/public-surveys/public-surveys.types.ts).
// Verified field-for-field against public-surveys.types.ts (backend) —
// identical shapes.
export const PublicSurveyLinkView = registerSchema(
  'PublicSurveyLinkView',
  T.Object({
    id: T.String(),
    needId: T.String(),
    studyId: T.String(),
    label: T.String(),
    token: T.String(),
    publicUrl: T.String(),
    expiresAt: T.Union([T.String(), T.Null()]),
    isActive: T.Boolean(),
    createdAt: T.String(),
    responseCount: T.Number(),
  }),
);

const SurveyResponseSummaryView = T.Object({
  id: T.String(),
  needId: T.String(),
  surveyLinkId: T.String(),
  contactName: T.Union([T.String(), T.Null()]),
  contact: T.String(),
  submittedAt: T.String(),
});

// Paginated envelope — registered as one wrapper schema (GAP-08 P0
// convention, see RouteDoc.responseSchema doc in src/contract/openapi.ts).
export const SurveyResponseListResult = registerSchema(
  'SurveyResponseListResult',
  T.Object({
    items: T.Array(SurveyResponseSummaryView),
    total: T.Number(),
    limit: T.Number(),
    offset: T.Number(),
  }),
);

const SurveyResponseAnswerView = T.Object({
  questionId: T.String(),
  questionText: T.String(),
  answerType: T.String(),
  answerOptions: T.Union([T.Array(T.String()), T.Null()]),
  answer: T.Union([T.String(), T.Null()]),
});

export const SurveyResponseDetailView = registerSchema(
  'SurveyResponseDetailView',
  T.Object({
    id: T.String(),
    needId: T.String(),
    surveyLinkId: T.String(),
    contactName: T.Union([T.String(), T.Null()]),
    contact: T.String(),
    submittedAt: T.String(),
    answers: T.Array(SurveyResponseAnswerView),
  }),
);

const QuestionResponseRowView = T.Object({
  responseId: T.String(),
  respondentName: T.Union([T.String(), T.Null()]),
  contact: T.String(),
  answer: T.Union([T.String(), T.Null()]),
  submittedAt: T.String(),
});

// Paginated envelope (with extra questionId/questionText/answerType header
// fields alongside items/total/limit/offset) — registered as one wrapper
// schema, same convention as SurveyResponseListResult above.
export const QuestionResponseListResult = registerSchema(
  'QuestionResponseListResult',
  T.Object({
    questionId: T.String(),
    questionText: T.String(),
    answerType: T.String(),
    items: T.Array(QuestionResponseRowView),
    total: T.Number(),
    limit: T.Number(),
    offset: T.Number(),
  }),
);
