-- Add optional Domain/Sub-domain/KPI metadata to survey_questions, so a
-- custom (additional) question can carry the same classification metadata a
-- Question Bank question already has via its linked Question row
-- (question_id -> questions.domain/sub_domain/kpi).
--
-- Nullable and purely additive: existing Question Bank-based rows are
-- unaffected (they keep resolving this via the Question relation, not these
-- new columns), and existing custom rows created before this migration keep
-- working with these columns left NULL — no backfill required. The
-- "required for every new custom question" rule from this point forward is
-- enforced at the application layer (Survey Builder's custom-question
-- dialog + service validation for newly-created rows), not a DB constraint,
-- specifically so re-saving a survey that still has older custom questions
-- never fails validation on rows nobody is actually editing.
ALTER TABLE "survey_questions"
  ADD COLUMN "domain" VARCHAR(120),
  ADD COLUMN "sub_domain" VARCHAR(120),
  ADD COLUMN "kpi" VARCHAR(200);
