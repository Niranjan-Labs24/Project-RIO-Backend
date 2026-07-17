-- Survey Link label (required, unique per Study) + optional surveyLinkId
-- scoping on the three Study Insights result tables (Response Quality, AI
-- Summary, Priority Score). See the PublicSurveyLink/ResponseQualityResult
-- model comments in schema.prisma.

-- 1. Add `label` as nullable first so existing rows (if any) can be
--    backfilled before the NOT NULL constraint goes on.
ALTER TABLE "public_survey_links" ADD COLUMN "label" VARCHAR(150);

-- 2. Backfill any pre-existing links with a sensible per-Study default —
--    "Survey Link #1", "Survey Link #2", ... ordered by createdAt within
--    each Study, so two links in the same Study never collide.
--    `public_survey_links` is FORCE ROW LEVEL SECURITY (org-scoped isolation
--    policy) — even the migration-running owner role is subject to it, so a
--    single cross-org backfill UPDATE would silently touch 0 rows outside
--    whatever org_id happens to be in the session. Drop FORCE for just this
--    statement, then restore it immediately after.
ALTER TABLE "public_survey_links" NO FORCE ROW LEVEL SECURITY;
WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "study_id" ORDER BY "created_at") AS rn
  FROM "public_survey_links"
  WHERE "label" IS NULL
)
UPDATE "public_survey_links" AS l
SET "label" = 'Survey Link #' || numbered.rn
FROM numbered
WHERE l."id" = numbered."id";
ALTER TABLE "public_survey_links" FORCE ROW LEVEL SECURITY;

-- 3. Now safe to enforce NOT NULL + uniqueness within the Study.
ALTER TABLE "public_survey_links" ALTER COLUMN "label" SET NOT NULL;
CREATE UNIQUE INDEX "public_survey_links_study_id_label_key" ON "public_survey_links"("study_id", "label");

-- 4. Optional survey-link scoping on Study Insights result tables — NULL
--    means "Consolidated" (computed across every link), a set value means
--    "computed for just that one link". Existing rows predate this feature
--    and were always computed across every link, so they stay NULL as-is
--    (no backfill needed — NULL is exactly the correct value for them).
ALTER TABLE "response_quality_results" ADD COLUMN "survey_link_id" UUID;
CREATE INDEX "response_quality_results_survey_link_id_idx" ON "response_quality_results"("survey_link_id");
ALTER TABLE "response_quality_results" ADD CONSTRAINT "response_quality_results_survey_link_id_fkey"
  FOREIGN KEY ("survey_link_id") REFERENCES "public_survey_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_summaries" ADD COLUMN "survey_link_id" UUID;
CREATE INDEX "ai_summaries_survey_link_id_idx" ON "ai_summaries"("survey_link_id");
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_survey_link_id_fkey"
  FOREIGN KEY ("survey_link_id") REFERENCES "public_survey_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "priority_scores" ADD COLUMN "survey_link_id" UUID;
CREATE INDEX "priority_scores_survey_link_id_idx" ON "priority_scores"("survey_link_id");
ALTER TABLE "priority_scores" ADD CONSTRAINT "priority_scores_survey_link_id_fkey"
  FOREIGN KEY ("survey_link_id") REFERENCES "public_survey_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
