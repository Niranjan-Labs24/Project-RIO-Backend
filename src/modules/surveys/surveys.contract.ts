import { registerSchema, T, type Static } from '../../contract/typebox';

// Exactly one of `questionId` (a Question Bank row's UUID) or `customText`
// (an additional, study-only open-ended question) is expected per item —
// enforced in SurveysService.updateQuestions, not at the schema level here,
// since TypeBox's structural validation can't express "exactly one of".
//
// domain/subDomain/kpi are optional here, not required, even though the
// Survey Builder dialog now requires them for every NEWLY created custom
// question — enforcing that at this shared schema level would also reject
// older custom questions (saved before these fields existed) the next time
// their survey's full question list gets re-saved, since Save always
// replaces the whole array at once. The dialog's own form validation is
// where "required for new questions" actually lives; see
// custom-question-editor-dialog.tsx on the frontend.
export const SurveyQuestionItem = T.Object({
  // Present only for a question carried over unchanged from what the
  // caller loaded (the SurveyQuestion row's own id) — omitted for a
  // newly-added item, since the backend hasn't generated its id yet. Used
  // purely to detect removals (see UpdateSurveyQuestionsBody's
  // removalReasons below); never trusted for anything else, since this
  // endpoint always deletes-and-recreates the whole set.
  id: T.Optional(T.String({ format: 'uuid' })),
  questionId: T.Optional(T.String()),
  customText: T.Optional(T.String({ minLength: 1 })),
  customAnswerType: T.Optional(T.String()),
  customOptions: T.Optional(T.Array(T.String())),
  domain: T.Optional(T.String({ minLength: 1 })),
  subDomain: T.Optional(T.String({ minLength: 1 })),
  kpi: T.Optional(T.String({ minLength: 1 })),
  order: T.Integer({ minimum: 1 }),
  isRequired: T.Boolean(),
});

export const UpdateSurveyQuestionsBody = registerSchema(
  'UpdateSurveyQuestionsBody',
  T.Object({
    questions: T.Array(SurveyQuestionItem),
    // Client-confirmed (Aug 13 call): a question the Reviewer removes
    // during their review (survey status SUBMITTED) must carry a reason —
    // free text for now, a fixed set of codes deferred until the client
    // hands one over. Keyed by the removed SurveyQuestionItem's own `id`.
    // SurveysService.updateQuestions rejects the request if any question
    // present in the survey before this call, and absent from `questions`
    // here, has no entry in this map — but only while status is SUBMITTED;
    // the Researcher's own DRAFT-phase edits never require a reason.
    removalReasons: T.Optional(T.Record(T.String({ format: 'uuid' }), T.String({ minLength: 1, maxLength: 500 }))),
  }),
);
export type UpdateSurveyQuestionsDto = Static<typeof UpdateSurveyQuestionsBody>;

// Matches the Prisma RejectionReasonCode enum's identifiers exactly (see
// schema.prisma) — REJ_99 is "Other"; every other code is a specific,
// closed-set reason.
export const RejectionReasonCode = T.Union([
  T.Literal('REJ_01'),
  T.Literal('REJ_02'),
  T.Literal('REJ_03'),
  T.Literal('REJ_04'),
  T.Literal('REJ_05'),
  T.Literal('REJ_06'),
  T.Literal('REJ_07'),
  T.Literal('REJ_99'),
]);

export const RejectSurveyBody = registerSchema(
  'RejectSurveyBody',
  T.Object({
    // A structured reason is always required. Reviewer notes (comments) are
    // now unconditionally required too, regardless of reasonCode — client
    // requirement: reviewer notes must be mandatory before publishing, for
    // both Approve and Reject. Whitespace-only strings pass minLength:1 (it
    // counts raw characters), so SurveysService.rejectSurvey also runs its
    // own trim-check — not expressible in TypeBox alone.
    reasonCode: RejectionReasonCode,
    comments: T.String({ minLength: 1, maxLength: 2000 }),
  }),
);
export type RejectSurveyDto = Static<typeof RejectSurveyBody>;

// Reviewer notes are mandatory on approve too — see RejectSurveyBody's
// comment for why this is required rather than optional, and why
// SurveysService.approveAndPublish still runs its own trim-check.
export const ApproveSurveyBody = registerSchema(
  'ApproveSurveyBody',
  T.Object({
    comments: T.String({ minLength: 1, maxLength: 2000 }),
  }),
);
export type ApproveSurveyDto = Static<typeof ApproveSurveyBody>;

export const SetMethodologyVersionBody = registerSchema(
  'SetMethodologyVersionBody',
  T.Object({
    version: T.String({ minLength: 1, maxLength: 100 }),
  }),
);
export type SetMethodologyVersionDto = Static<typeof SetMethodologyVersionBody>;

// All four fields are required together — this is a single Save action for
// the whole Sample Description step, not four independent field updates
// (matches the frontend's one Card / one Save button). Whether the step as
// a whole is required before Submit for Approval is enforced separately in
// SurveysService.submitForApproval, same split as methodologyVersion above.
export const SetSampleDescriptionBody = registerSchema(
  'SetSampleDescriptionBody',
  T.Object({
    targetGroup: T.String({ minLength: 1, maxLength: 500 }),
    expectedSampleSize: T.Integer({ minimum: 1 }),
    selectionApproach: T.String({ minLength: 1, maxLength: 1000 }),
    geographicCoverage: T.String({ minLength: 1, maxLength: 500 }),
  }),
);
export type SetSampleDescriptionDto = Static<typeof SetSampleDescriptionBody>;

// Keyed by SurveyQuestion.id (a UUID) -> the respondent's free-text answer.
// Bounded on both axes (question count, answer length) purely as a
// payload-size/DoS guard — SurveysService.submitSurvey doesn't itself cap
// either today.
export const SubmitSurveyBody = registerSchema(
  'SubmitSurveyBody',
  T.Object(
    {
      answers: T.Record(T.String({ minLength: 1, maxLength: 100 }), T.String({ maxLength: 5000 }), {
        maxProperties: 500,
      }),
    },
    { additionalProperties: false },
  ),
);
export type SubmitSurveyDto = Static<typeof SubmitSurveyBody>;

// Response schemas (GAP-08 Phase 0, batch 3) — shape sourced from the
// frontend's Survey/SurveyQuestionItem/SurveyRecord/SurveyResponseStats/
// ReusableCustomQuestion (Project-RIO-Frontend/src/services/surveys/
// surveys.service.ts — this module has no separate *.types.ts file, the
// types live alongside the service). Verified field-for-field against
// SurveysService's toQuestionDto/toSurveyDetailDto (backend).
export const SurveyQuestionItemView = registerSchema(
  'SurveyQuestionItem',
  T.Object({
    id: T.String(),
    bankQuestionId: T.Union([T.String(), T.Null()]),
    questionCode: T.Union([T.String(), T.Null()]),
    questionText: T.String(),
    answerType: T.String(),
    answerOptions: T.Union([T.Array(T.String()), T.Null()]),
    domain: T.Union([T.String(), T.Null()]),
    subDomain: T.Union([T.String(), T.Null()]),
    indicator: T.Union([T.String(), T.Null()]),
    kpi: T.Union([T.String(), T.Null()]),
    isCustom: T.Boolean(),
    order: T.Number(),
    isRequired: T.Boolean(),
  }),
);

// Matches the Prisma RejectionReasonCode enum's identifiers exactly — same
// closed set as RejectionReasonCode above (the request-side union), just
// nullable for a survey that's never been rejected.
const RejectionReasonCodeView = T.Union([
  T.Literal('REJ_01'),
  T.Literal('REJ_02'),
  T.Literal('REJ_03'),
  T.Literal('REJ_04'),
  T.Literal('REJ_05'),
  T.Literal('REJ_06'),
  T.Literal('REJ_07'),
  T.Literal('REJ_99'),
]);

// The full Survey Builder record — returned by getSurveyByNeedId,
// createEmptySurvey, recommendQuestions, updateQuestions,
// setMethodologyVersion, and createNewVersion (all resolve through
// SurveysService#toSurveyDetailDto or #getSurveyByNeedId).
export const Survey = registerSchema(
  'Survey',
  T.Object({
    id: T.String(),
    needId: T.String(),
    studyId: T.String(),
    title: T.String(),
    status: T.Union([
      T.Literal('DRAFT'),
      T.Literal('SUBMITTED'),
      T.Literal('APPROVED'),
      T.Literal('REJECTED'),
      T.Literal('PUBLISHED'),
      T.Literal('SUPERSEDED'),
    ]),
    methodologyVersion: T.Union([T.String(), T.Null()]),
    targetGroup: T.Union([T.String(), T.Null()]),
    expectedSampleSize: T.Union([T.Number(), T.Null()]),
    selectionApproach: T.Union([T.String(), T.Null()]),
    geographicCoverage: T.Union([T.String(), T.Null()]),
    submittedAt: T.Union([T.String(), T.Null()]),
    approverComments: T.Union([T.String(), T.Null()]),
    rejectionReasonCode: T.Union([RejectionReasonCodeView, T.Null()]),
    approvedAt: T.Union([T.String(), T.Null()]),
    approvedBy: T.Union([T.String(), T.Null()]),
    approvedByName: T.Union([T.String(), T.Null()]),
    rejectedAt: T.Union([T.String(), T.Null()]),
    rejectedBy: T.Union([T.String(), T.Null()]),
    rejectedByName: T.Union([T.String(), T.Null()]),
    publishedAt: T.Union([T.String(), T.Null()]),
    publishedBy: T.Union([T.String(), T.Null()]),
    publishedByName: T.Union([T.String(), T.Null()]),
    questions: T.Array(SurveyQuestionItemView),
    version: T.Number(),
    previousVersionId: T.Union([T.String(), T.Null()]),
  }),
);

// The approve/reject/submit-for-approval endpoints' response — the raw
// Survey DB row (SurveysService.submitForApproval/approveSurvey/
// rejectSurvey all return the bare `tx.survey.update()` result, a superset
// of this). Registered per the frontend's own trimmed SurveyRecord shape
// (surveys.service.ts) — the fields the Survey Builder UI actually reads
// off these three responses.
export const SurveyRecord = registerSchema(
  'SurveyRecord',
  T.Object({
    id: T.String(),
    needId: T.String(),
    studyId: T.String(),
    title: T.String(),
    status: T.Union([
      T.Literal('DRAFT'),
      T.Literal('SUBMITTED'),
      T.Literal('APPROVED'),
      T.Literal('REJECTED'),
      T.Literal('PUBLISHED'),
      T.Literal('SUPERSEDED'),
    ]),
  }),
);

// NOTE (discrepancy, flagged): ROUTES previously labeled GET
// /surveys/public/{id}'s response 'PublicSurveyView' — that name exists
// nowhere in the frontend (surveysService.getPublicSurvey types its result
// as the full `Survey`, which the actual response is NOT — no
// methodologyVersion/approvedAt/etc. fields). Registered here as a
// best-effort schema from the backend's real return shape
// (SurveysService.getPublicSurvey: `{ id, title, status, questions }`),
// since neither the frontend's Survey type nor any FE-declared
// PublicSurveyView type actually matches this endpoint.
export const PublicSurveyView = registerSchema(
  'PublicSurveyView',
  T.Object({
    id: T.String(),
    title: T.String(),
    status: T.String(),
    questions: T.Array(SurveyQuestionItemView),
  }),
);

// POST /surveys/public/{id}/submit's response — the backend returns the
// raw created `surveyBuilderResponse` row (superset: also carries
// surveyId/answers), but the frontend's submitAnswers() only types/reads
// `{ id, submittedAt }` (SubmitAnswersResult in surveys.service.ts).
// Registered per the frontend's trimmed shape.
export const SubmitAnswersResult = registerSchema(
  'SubmitAnswersResult',
  T.Object({
    id: T.String(),
    submittedAt: T.String(),
  }),
);

// GET /surveys/{id}/responses's response — a single stats object, not an
// array. NOTE (discrepancy, fixed here): ROUTES previously described this
// route's response as `SurveyResponse[]`, but SurveysService.getSurveyResponses
// returns one `{ id, title, status, totalRespondents, stats }` object per
// call (matches the frontend's SurveyResponseStats in surveys.service.ts
// exactly) — not an array, and not the per-answer `SurveyResponse` shape
// the old label implied. Fixed to the real shape/cardinality below.
const ResponseSliceView = T.Object({
  label: T.String(),
  count: T.Number(),
  percentage: T.Number(),
  color: T.String(),
});

const QuestionResponseStatsView = T.Object({
  questionId: T.String(),
  questionText: T.String(),
  answerType: T.String(),
  slices: T.Array(ResponseSliceView),
  textResponses: T.Optional(T.Array(T.String())),
});

export const SurveyResponseStats = registerSchema(
  'SurveyResponseStats',
  T.Object({
    id: T.String(),
    title: T.String(),
    status: T.String(),
    totalRespondents: T.Number(),
    stats: T.Array(QuestionResponseStatsView),
  }),
);

// GET /custom-questions's response — SurveysService.listReusableCustomQuestions.
// Named 'CustomQuestion' to match ROUTES' existing response label; shape
// sourced from the frontend's ReusableCustomQuestion (surveys.service.ts).
export const CustomQuestion = registerSchema(
  'CustomQuestion',
  T.Object({
    id: T.String(),
    questionText: T.String(),
    answerType: T.String(),
    answerOptions: T.Union([T.Array(T.String()), T.Null()]),
    domain: T.Union([T.String(), T.Null()]),
    subDomain: T.Union([T.String(), T.Null()]),
    kpi: T.Union([T.String(), T.Null()]),
    sourceSurveyTitle: T.String(),
  }),
);
