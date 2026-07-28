-- Merge-drift recovery migration.
-- Ayush's branch was merged with the schema.prisma changes (Evidence report
-- columns + the AiPrioritySummary model) but WITHOUT their migrations, so these
-- objects were missing on migrated databases (and were only patched into the
-- dev DB via `prisma db push`, which also skipped the grants/RLS the app needs).
--
-- This migration is written idempotently (IF NOT EXISTS / guarded blocks) so it
-- runs cleanly on a fresh database AND is a safe no-op where `db push` already
-- created these objects.

-- ── Evidence: report/curation columns ──
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "title" VARCHAR(300);
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "source_reference_id" VARCHAR(200);
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "linked_domain_or_kpi" VARCHAR(200);
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "collected_at" TIMESTAMPTZ(6);
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "review_status" VARCHAR(50) NOT NULL DEFAULT 'APPROVED';
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "is_included_in_report" BOOLEAN NOT NULL DEFAULT true;

-- ── AiPrioritySummary status enum ──
DO $$ BEGIN
  CREATE TYPE "AiPrioritySummaryStatus" AS ENUM ('DRAFT', 'SAVED', 'OFFICER_CONFIRMED', 'STALE', 'SUPERSEDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── AiPrioritySummary table ──
CREATE TABLE IF NOT EXISTS "ai_priority_summaries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "village_id" VARCHAR(150) NOT NULL DEFAULT '',
    "report_data_snapshot_id" VARCHAR(100) NOT NULL,
    "status" "AiPrioritySummaryStatus" NOT NULL DEFAULT 'DRAFT',
    "summary_scope" VARCHAR(50) NOT NULL DEFAULT 'VILLAGE',
    "scope_filters" JSONB,
    "prompt_version" VARCHAR(100) NOT NULL DEFAULT 'priority-dashboard-summary-v1',
    "prompt_hash" VARCHAR(64) NOT NULL,
    "model_name" VARCHAR(100) NOT NULL DEFAULT 'gemini-2.5-flash',
    "model_version" VARCHAR(50) NOT NULL DEFAULT 'v1',
    "input_report_data_hash" VARCHAR(64) NOT NULL,
    "input_evidence_snapshot_hash" VARCHAR(64) NOT NULL,
    "ai_output_json" JSONB NOT NULL,
    "officer_edited_output_json" JSONB,
    "generated_by" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "officer_confirmed_by" UUID,
    "officer_confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_priority_summaries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ai_priority_summaries_org_id_idx" ON "ai_priority_summaries"("org_id");
CREATE INDEX IF NOT EXISTS "ai_priority_summaries_study_id_idx" ON "ai_priority_summaries"("study_id");
CREATE INDEX IF NOT EXISTS "ai_priority_summaries_survey_id_idx" ON "ai_priority_summaries"("survey_id");
CREATE INDEX IF NOT EXISTS "ai_priority_summaries_study_id_survey_id_village_id_status_idx" ON "ai_priority_summaries"("study_id", "survey_id", "village_id", "status");

DO $$ BEGIN
  ALTER TABLE "ai_priority_summaries" ADD CONSTRAINT "ai_priority_summaries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ai_priority_summaries" ADD CONSTRAINT "ai_priority_summaries_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ai_priority_summaries" ADD CONSTRAINT "ai_priority_summaries_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Row-level security + role grants (org isolation, matching every tenant table) ──
ALTER TABLE "ai_priority_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_priority_summaries" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_priority_summaries_org_isolation ON "ai_priority_summaries";
CREATE POLICY ai_priority_summaries_org_isolation ON "ai_priority_summaries"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_priority_summaries" TO cnap_app;
GRANT SELECT ON "ai_priority_summaries" TO cnap_supervisor;

DROP POLICY IF EXISTS ai_priority_summaries_supervisor_read ON "ai_priority_summaries";
CREATE POLICY ai_priority_summaries_supervisor_read ON "ai_priority_summaries"
  FOR SELECT TO cnap_supervisor USING (true);
