-- Phase A.5 (data-only, no DDL): backfill every new column added in
-- 20260717190000_need_multi_scope_additive. Safe today because every Study
-- has at most one Need (the OLD 1:1 constraint, not yet dropped) — this is
-- the last migration that gets to rely on that being true.

-- Need.status: map the old Study.status onto its one Need, refining further
-- if a Survey already exists for that Study (further along than the plain
-- Study.status mapping alone would suggest).
UPDATE "needs" n
SET
  "status" = (
    CASE
      WHEN EXISTS (SELECT 1 FROM "surveys" sv WHERE sv."study_id" = n."study_id" AND sv."status" = 'PUBLISHED')
        THEN 'survey_published'
      WHEN EXISTS (SELECT 1 FROM "surveys" sv WHERE sv."study_id" = n."study_id")
        THEN 'survey_created'
      WHEN s."status" = 'human_reviewed' THEN 'reviewer_approved'
      WHEN s."status" = 'ai_classified' THEN 'ai_classified'
      WHEN s."status" = 'evidence_submitted' THEN 'evidence_submitted'
      ELSE 'draft'
    END
  )::"NeedStatus",
  "domain" = s."domain",
  "sub_domain" = s."sub_domain"
FROM "studies" s
WHERE n."study_id" = s."id";

-- needId on every child row — joins on the still-unique Need.studyId.
UPDATE "evidence" e SET "need_id" = n."id" FROM "needs" n WHERE e."study_id" = n."study_id";
UPDATE "ai_decisions" ad SET "need_id" = n."id" FROM "needs" n WHERE ad."study_id" = n."study_id";
UPDATE "public_survey_links" l SET "need_id" = n."id" FROM "needs" n WHERE l."study_id" = n."study_id";
UPDATE "survey_responses" sr SET "need_id" = n."id" FROM "needs" n WHERE sr."study_id" = n."study_id";
UPDATE "response_quality_results" rqr SET "need_id" = n."id" FROM "needs" n WHERE rqr."study_id" = n."study_id";
UPDATE "ai_summaries" asu SET "need_id" = n."id" FROM "needs" n WHERE asu."study_id" = n."study_id";
UPDATE "priority_scores" ps SET "need_id" = n."id" FROM "needs" n WHERE ps."study_id" = n."study_id";
UPDATE "ai_suggestions" ags SET "need_id" = n."id" FROM "needs" n WHERE ags."study_id" = n."study_id";
UPDATE "surveys" sv SET "need_id" = n."id" FROM "needs" n WHERE sv."study_id" = n."study_id";
