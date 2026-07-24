import { registerSchema, T, type Static } from '../../contract/typebox';

// Exactly one of `questionId` (a Question Bank row's UUID) or `customText`
// (an additional, study-only open-ended question) is expected per item —
// enforced in SurveysService.updateQuestions, not at the schema level here,
// since TypeBox's structural validation can't express "exactly one of".
export const SurveyQuestionItem = T.Object({
  questionId: T.Optional(T.String()),
  customText: T.Optional(T.String({ minLength: 1 })),
  customAnswerType: T.Optional(T.String()),
  customOptions: T.Optional(T.Array(T.String())),
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
