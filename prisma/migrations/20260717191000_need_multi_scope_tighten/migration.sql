-- Phase B: tighten every column Phase A added nullable + Phase A.5 backfilled,
-- add the real FKs/indexes/uniques, and drop what a Study no longer owns
-- (pipeline state moved to Need; a Study is a pure container now).

-- needId: NOT NULL + FK + index, one table at a time.
ALTER TABLE "evidence" ALTER COLUMN "need_id" SET NOT NULL;
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "evidence_need_id_idx" ON "evidence"("need_id");
DROP INDEX IF EXISTS "evidence_study_id_file_hash_idx";
CREATE INDEX "evidence_need_id_file_hash_idx" ON "evidence"("need_id", "file_hash");

ALTER TABLE "ai_decisions" ALTER COLUMN "need_id" SET NOT NULL;
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ai_decisions_need_id_idx" ON "ai_decisions"("need_id");

ALTER TABLE "public_survey_links" ALTER COLUMN "need_id" SET NOT NULL;
ALTER TABLE "public_survey_links" ADD CONSTRAINT "public_survey_links_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX IF EXISTS "public_survey_links_study_id_label_key";
CREATE UNIQUE INDEX "public_survey_links_need_id_label_key" ON "public_survey_links"("need_id", "label");
CREATE INDEX "public_survey_links_need_id_idx" ON "public_survey_links"("need_id");

ALTER TABLE "survey_responses" ALTER COLUMN "need_id" SET NOT NULL;
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "survey_responses_need_id_idx" ON "survey_responses"("need_id");

ALTER TABLE "response_quality_results" ALTER COLUMN "need_id" SET NOT NULL;
ALTER TABLE "response_quality_results" ADD CONSTRAINT "response_quality_results_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "response_quality_results_need_id_idx" ON "response_quality_results"("need_id");

ALTER TABLE "ai_summaries" ALTER COLUMN "need_id" SET NOT NULL;
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ai_summaries_need_id_idx" ON "ai_summaries"("need_id");

ALTER TABLE "priority_scores" ALTER COLUMN "need_id" SET NOT NULL;
ALTER TABLE "priority_scores" ADD CONSTRAINT "priority_scores_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "priority_scores_need_id_idx" ON "priority_scores"("need_id");

ALTER TABLE "ai_suggestions" ALTER COLUMN "need_id" SET NOT NULL;
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ai_suggestions_need_id_idx" ON "ai_suggestions"("need_id");

ALTER TABLE "surveys" ALTER COLUMN "need_id" SET NOT NULL;
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "surveys_need_id_idx" ON "surveys"("need_id");

-- Need is no longer 1:1 with Study — a Study can now have many Needs.
DROP INDEX "needs_study_id_key";
CREATE INDEX "needs_study_id_idx" ON "needs"("study_id");

-- Study becomes a pure container — pipeline state (status/domain/subDomain)
-- lives on Need now (see the additive migration + backfill).
ALTER TABLE "studies" DROP COLUMN "status";
ALTER TABLE "studies" DROP COLUMN "domain";
ALTER TABLE "studies" DROP COLUMN "sub_domain";
DROP TYPE "StudyStatus";
