-- Additional/open-ended questions can now be Multiple Choice or Checkbox
-- type, which need their own options list — Question Bank questions still
-- get their options from `questions.answer_options`, this is only for the
-- custom (question_id IS NULL) side of survey_questions.
ALTER TABLE "survey_questions" ADD COLUMN "custom_options" JSONB;
