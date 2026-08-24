import { registerSchema, T, type Static } from '../../contract/typebox';

// RIO-FR-012 (Q31, client-confirmed 2026-08-20) — "creating a new question"
// is explicitly listed as one of the change types requiring Human Reviewer
// approval before it becomes active for new surveys, same as an edit — see
// QuestionsService.create().
//
// 'open_ended' is a first-class answerType here (RIO-FR-012 AC2,
// client-confirmed Q1: "Open-ended questions are a separate approved
// question type — not the same as disallowed custom questions... maintained
// as part of the Question Bank"). The other four match the answer types
// already present in the imported v5.0 bank.
export const CreateQuestionBody = registerSchema(
  'CreateQuestionBody',
  T.Object(
    {
      questionId: T.String({ minLength: 1, maxLength: 64 }),
      domain: T.String({ minLength: 1, maxLength: 120 }),
      subDomain: T.String({ minLength: 1, maxLength: 120 }),
      indicator: T.Optional(T.String({ maxLength: 200 })),
      kpi: T.Optional(T.String({ maxLength: 200 })),
      questionText: T.String({ minLength: 1 }),
      answerType: T.Union([
        T.Literal('select'),
        T.Literal('multiselect'),
        T.Literal('numeric'),
        T.Literal('checklist'),
        T.Literal('open_ended'),
      ]),
      // Required for select/multiselect/checklist, meaningless for
      // numeric/open_ended — enforced in the service, not the schema (the
      // right option set depends on answerType, which TypeBox alone can't
      // conditionally require without a discriminated union per type).
      answerOptions: T.Optional(T.Array(T.String({ minLength: 1 }))),
      requiredOptional: T.Union([T.Literal('required'), T.Literal('optional')]),
      // RIO-FR-012/RIO-AI-002 (Round 4, client-confirmed 2026-08-24) — one
      // of the configured TargetSectorOption values, or omitted/null if
      // this question isn't tagged. Used only as a suggested-question
      // ranking signal, never a hard filter — see
      // SurveysService.generateSuggestedQuestions.
      targetSector: T.Optional(T.String({ maxLength: 100 })),
    },
    { additionalProperties: false },
  ),
);
export type CreateQuestionDto = Static<typeof CreateQuestionBody>;
