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
  }),
);
export type UpdateSurveyQuestionsDto = Static<typeof UpdateSurveyQuestionsBody>;

export const RejectSurveyBody = registerSchema(
  'RejectSurveyBody',
  T.Object({
    // The Approver's reason — required, since "reject with no explanation"
    // gives the Researcher nothing to act on before resubmitting.
    comments: T.String({ minLength: 1, maxLength: 2000 }),
  }),
);
export type RejectSurveyDto = Static<typeof RejectSurveyBody>;

export const SetMethodologyVersionBody = registerSchema(
  'SetMethodologyVersionBody',
  T.Object({
    version: T.String({ minLength: 1, maxLength: 100 }),
  }),
);
export type SetMethodologyVersionDto = Static<typeof SetMethodologyVersionBody>;
