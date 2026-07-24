-- Phase A (additive) of the "many Needs per Study" migration. Adds every
-- new column NULLABLE so existing rows stay valid; the backfill script runs
-- next, then Phase B (20260717191000_need_multi_scope_tighten) makes these
-- NOT NULL and adds the real constraints. Splitting it this way means a
-- database with real rows never sees a moment where a NOT NULL column has
-- no value to put in it.

-- Need's own lifecycle (was tracked via Study.status) plus the classification
-- result (was Study.domain/subDomain) — each Need now runs independently.
CREATE TYPE "NeedStatus" AS ENUM ('draft', 'evidence_submitted', 'ai_classified', 'reviewer_approved', 'survey_created', 'survey_published');

ALTER TABLE "needs" ADD COLUMN "status" "NeedStatus" NOT NULL DEFAULT 'draft';
ALTER TABLE "needs" ADD COLUMN "domain" VARCHAR(120);
ALTER TABLE "needs" ADD COLUMN "sub_domain" VARCHAR(120);

-- needId columns — nullable for now, backfilled next, tightened in Phase B.
ALTER TABLE "evidence" ADD COLUMN "need_id" UUID;
ALTER TABLE "ai_decisions" ADD COLUMN "need_id" UUID;
ALTER TABLE "public_survey_links" ADD COLUMN "need_id" UUID;
ALTER TABLE "survey_responses" ADD COLUMN "need_id" UUID;
ALTER TABLE "response_quality_results" ADD COLUMN "need_id" UUID;
ALTER TABLE "ai_summaries" ADD COLUMN "need_id" UUID;
ALTER TABLE "priority_scores" ADD COLUMN "need_id" UUID;
ALTER TABLE "ai_suggestions" ADD COLUMN "need_id" UUID;
ALTER TABLE "surveys" ADD COLUMN "need_id" UUID;

-- Priority Scoring stays subject to reviewer approval — never publicly
-- visible until approved (see PriorityScore.approvedBy/approvedAt).
ALTER TABLE "priority_scores" ADD COLUMN "approved_by" UUID;
ALTER TABLE "priority_scores" ADD COLUMN "approved_at" TIMESTAMPTZ(6);
