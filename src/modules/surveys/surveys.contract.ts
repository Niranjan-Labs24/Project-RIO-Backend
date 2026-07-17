import { registerSchema, T, type Static } from '../../contract/typebox';

export const SurveyQuestionItem = T.Object({
  questionId: T.String(),
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

export const SaveSurveyDraftBody = registerSchema(
  'SaveSurveyDraftBody',
  T.Object({
    status: T.Optional(T.String()),
  }),
);
export type SaveSurveyDraftDto = Static<typeof SaveSurveyDraftBody>;
