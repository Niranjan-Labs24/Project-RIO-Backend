-- Additional (open-ended) Survey questions: study-specific questions a
-- Research Officer adds directly on a Survey, never written into the
-- Question Bank (`questions` table). Discriminated on `question_id`:
-- NULL means this row is an additional question, using `custom_text` /
-- `custom_answer_type` instead of the Question Bank relation.
ALTER TABLE "survey_questions" ALTER COLUMN "question_id" DROP NOT NULL;
ALTER TABLE "survey_questions" ADD COLUMN "custom_text" TEXT;
ALTER TABLE "survey_questions" ADD COLUMN "custom_answer_type" VARCHAR(64);

-- Exactly one of "Question Bank question" or "additional question" per row
-- — never both, never neither.
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_bank_or_custom_check"
  CHECK (
    (question_id IS NOT NULL AND custom_text IS NULL)
    OR (question_id IS NULL AND custom_text IS NOT NULL)
  );
