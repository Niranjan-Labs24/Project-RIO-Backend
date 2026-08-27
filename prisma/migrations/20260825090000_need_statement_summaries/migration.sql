-- RIO-AI-003 — "When a long need or text file is entered, the system suggests
-- a standardized, editable summary before approval."
--
-- Three client decisions (25 Aug 2026) are encoded here:
--
--  1. ALL entry points are in scope — manual entry, bulk import, PDF
--     extraction and (when RIO-AI-006 lands) citizen free text. Hence
--     trigger_source rather than a per-entry-point table.
--  2. The threshold is 1,500 characters for EVERY language. A word count was
--     rejected: Arabic is materially more compact per character than English,
--     so one word threshold would behave as two different rules.
--  3. "Standardised" means the STRUCTURED facts survive untouched — centre,
--     village, governorate, problem title, domain. Only the narrative is
--     rewritten. Those fields are therefore absent from this table: they are
--     read from the Need itself at display time, so the model has no way to
--     corrupt them even if it hallucinates.

-- ── Configurable threshold (the AC's "defined length threshold") ──────────
--
-- NOT NULL with a DEFAULT, same reasoning as ai_classification_settings: the
-- default backfills the existing methodology_configs row and keeps
-- MethodologyConfigService.findRowOrThrow's self-heal insert working when it
-- runs against a client generated before this column existed.
--
-- maxSummaryChars is a cap on the OUTPUT, not the input. Without it the model
-- happily returns a "summary" longer than the source on short-but-over-
-- threshold statements, which is worse than not summarising at all.
ALTER TABLE "methodology_configs"
  ADD COLUMN "ai_summary_settings" JSONB NOT NULL
  DEFAULT '{"statementLengthThreshold": 1500, "maxSummaryChars": 600}'::jsonb;

-- RIO-NFR-017 asks for a history of EVERY configuration change. Omitting this
-- column would produce history rows that silently record nothing at all when
-- the summarisation threshold is the only thing an administrator changed.
ALTER TABLE "methodology_config_history"
  ADD COLUMN "ai_summary_settings" JSONB NOT NULL
  DEFAULT '{"statementLengthThreshold": 1500, "maxSummaryChars": 600}'::jsonb;

-- ── The summaries themselves ─────────────────────────────────────────────
CREATE TABLE "need_statement_summaries" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "org_id" UUID NOT NULL,
  "need_id" UUID NOT NULL,
  "study_id" UUID NOT NULL,
  "status" VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
  "prompt_version" VARCHAR(100) NOT NULL,
  "model_name" VARCHAR(100) NOT NULL,
  "model_version" VARCHAR(50) NOT NULL,
  -- AC: "the original full text remains accessible/retrievable alongside the
  -- summary". Snapshotted rather than joined to needs.statement so that
  -- editing the Need later cannot silently re-caption an already-confirmed
  -- summary — that path marks the summary STALE instead.
  "source_statement" TEXT NOT NULL,
  "source_length" INTEGER NOT NULL,
  "input_text_hash" VARCHAR(64) NOT NULL,
  -- The model's own text. Never overwritten: the AC requires the AI
  -- suggestion and the human decision to be stored TOGETHER, which is only
  -- provable if they occupy separate columns.
  "ai_summary_text" TEXT NOT NULL,
  -- NULL means "confirmed the AI text unchanged" — itself a real decision,
  -- and one that must stay distinguishable from "edited it to the same
  -- string".
  "reviewer_edited_text" TEXT,
  "trigger_source" VARCHAR(40) NOT NULL,
  -- AC 5 made mechanical (need-summary.verify.ts). "CODE:detail" per provably
  -- wrong thing found in the generated summary. A real TEXT[], following the
  -- needs.village precedent -- never a comma-joined string.
  "verification_warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "generated_by" UUID,
  "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "confirmed_by" UUID,
  "confirmed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "need_statement_summaries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "need_statement_summaries_org_id_idx" ON "need_statement_summaries"("org_id");
CREATE INDEX "need_statement_summaries_need_id_idx" ON "need_statement_summaries"("need_id");
CREATE INDEX "need_statement_summaries_study_id_idx" ON "need_statement_summaries"("study_id");
-- The reviewer queue reads "every DRAFT in my org, oldest first".
CREATE INDEX "need_statement_summaries_org_id_status_idx" ON "need_statement_summaries"("org_id", "status");

ALTER TABLE "need_statement_summaries" ADD CONSTRAINT "need_statement_summaries_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "need_statement_summaries" ADD CONSTRAINT "need_statement_summaries_need_id_fkey"
  FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "need_statement_summaries" ADD CONSTRAINT "need_statement_summaries_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "need_statement_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "need_statement_summaries" FORCE ROW LEVEL SECURITY;

CREATE POLICY need_statement_summaries_org_isolation ON "need_statement_summaries"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON "need_statement_summaries" TO cnap_app;
GRANT SELECT ON "need_statement_summaries" TO cnap_supervisor;

CREATE POLICY need_statement_summaries_supervisor_read ON "need_statement_summaries"
  FOR SELECT TO cnap_supervisor USING (true);
