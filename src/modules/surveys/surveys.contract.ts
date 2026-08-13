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
