-- The methodology-aligned Question Bank import (H*/ED*/WS*/LV*/SD*/GV*
-- question codes) landed alongside older, pre-existing questions that share
-- the exact same domain/sub-domain and near-identical wording (e.g. legacy
-- "W01" vs the real "WS01", both "Water & Sanitation / Drinking Water
-- Access", both reading "What is the main source of drinking water for this
-- household?"). Survey Builder's Question Bank picker (and "Generate AI
-- Suggestions") can't tell them apart by text alone, so surveys kept
-- accidentally picking the legacy question — which has no scoring lookup —
-- instead of the real one.
--
-- `used_in_mvp = false` hides a question from the picker (see
-- QuestionsService.getDomainOptions/getQuestions, both filter on it)
-- without deleting anything: any survey that already added one of these
-- legacy questions keeps working exactly as before, since existing
-- SurveyQuestion rows reference the Question by id, not by this flag.
UPDATE "questions"
SET "used_in_mvp" = false
WHERE "question_id" !~ '^(H|ED|WS|LV|SD|GV)[0-9]+$'
  AND ("domain", "sub_domain") IN (
    SELECT "domain", "sub_domain" FROM "questions" WHERE "question_id" ~ '^(H|ED|WS|LV|SD|GV)[0-9]+$'
  );
