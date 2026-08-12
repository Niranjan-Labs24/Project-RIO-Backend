-- RIO-AI-005 (legacy FR-19) — approved methodology implementation baseline.
--
-- Makes the Question Bank version-scoped so a second methodology version can be
-- imported without colliding with the first, and adds the v5.0 columns the
-- signed-off methodology needs.
--
-- WHY THIS IS NEEDED: `questions.question_id` was globally unique and
-- `methodology_version_id` was never populated by the importer, so every
-- question in the database lived in one flat namespace regardless of which
-- methodology version it belonged to. Importing a second bank alongside the
-- first therefore produced near-duplicate questions in the same
-- domain/sub-domain that the Survey Builder picker could not tell apart — a
-- real, already-observed bug that had to be patched twice with hand-written
-- prefix-regex UPDATEs (20260721071548_deactivate_legacy_duplicate_questions and
-- its _pt2 follow-up, which records the live symptom: "a fresh 'Poor Road
-- Connectivity' survey picked legacy I03 instead of the real IN03"). Version
-- scoping replaces that whole approach — do NOT add a third such migration.

-- ── 1. Backfill every existing question onto the v1.0 baseline ──────────────
-- The v1.0 MethodologyVersion row is created lazily at runtime by
-- import-scoring-lookups.ts rather than by a migration, so it may or may not
-- exist here. Create it if absent so the backfill below always has a target,
-- and so v1.0 stays resolvable for surveys already published against it
-- (Survey.methodology_version stores the label as a plain string snapshot).
DO $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
    FROM "methodology_versions"
   WHERE version = 'v1.0 - Approved implementation baseline';

  IF v_id IS NULL THEN
    INSERT INTO "methodology_versions" (id, name, version, status, description, created_by, updated_at)
    VALUES (
      uuidv7(),
      'Methodology Version v1.0 - Approved implementation baseline',
      'v1.0 - Approved implementation baseline',
      'PUBLISHED',
      'Pre-v5.0 baseline: the 102-question bank extracted from "Project Rio 1.xlsx" on 2026-07-15. Retained (never deleted) so surveys and severity scores already recorded against it keep resolving.',
      '00000000-0000-0000-0000-000000000000'::uuid,
      now()
    )
    RETURNING id INTO v_id;
  END IF;

  UPDATE "questions"
     SET "methodology_version_id" = v_id
   WHERE "methodology_version_id" IS NULL;
END $$;

-- ── 2. v5.0 columns ────────────────────────────────────────────────────────
-- All either nullable or defaulted, so the backfill above needs no second pass.
ALTER TABLE "questions"
  -- The workbook's verbatim Answer Type label (23 distinct values in v5.0, e.g.
  -- "Numeric (roster, per woman)"). `measurement_mode` is the decomposed base
  -- type that drives scoring; this keeps the original for traceability.
  ADD COLUMN "answer_type_raw" VARCHAR(120),
  -- "person" | "child" | "woman" | "youth" — set when the question is
  -- administered once per eligible individual.
  ADD COLUMN "roster_scope" VARCHAR(20),
  -- Compound type ("X + barrier", "Numeric (multi-component)", "... matrix"):
  -- the base type drives severity, the follow-up is diagnostic detail only.
  ADD COLUMN "is_compound" BOOLEAN NOT NULL DEFAULT false,
  -- Answered from a facility/administrative record, not by a household (WSH-15).
  ADD COLUMN "is_admin_record" BOOLEAN NOT NULL DEFAULT false,
  -- False for the 7 questionnaire-structure/roster/template modules
  -- (XDM-01..07), which are instrument scaffolding, not fielded questions.
  -- 193 total - 7 = 186 field items.
  ADD COLUMN "is_fielded" BOOLEAN NOT NULL DEFAULT true,
  -- 186 field items - WSH-15 (administrative record) - SOC-08 (on hold under
  -- the sensitivity protocol) = the 184 actually asked of a household.
  ADD COLUMN "is_household_fielded" BOOLEAN NOT NULL DEFAULT true,
  -- XDM-08 (major household shocks) is scored but excluded BY DESIGN from the
  -- nine-domain Village Development Needs Index; it feeds the vulnerability
  -- classification instead (METH Change Summary v5.0, item 9).
  ADD COLUMN "excluded_from_nine_domain_index" BOOLEAN NOT NULL DEFAULT false,
  -- For the 20 feeder items: the anchor KPI's question code they enrich
  -- ("Feeds KPI (anchor code)" on METH — KPI-Domain Rollup). Selective
  -- enrichment — most KPIs stay 1:1 with a single question.
  ADD COLUMN "feeds_kpi_anchor" VARCHAR(64),
  -- The v1.0 -> v5.0 code map ("Former code: H01" in the workbook's Notes
  -- column). Every one of the 193 v5.0 items carries one, which is what makes a
  -- like-for-like comparison against v1.0 data possible.
  ADD COLUMN "former_code" VARCHAR(64),
  ADD COLUMN "target_respondent" TEXT,
  -- The roster iteration scope in the methodology's own words, e.g. "each child
  -- aged 0-59 months". Kept verbatim: `roster_scope` above is the machine-usable
  -- reduction, this is the auditable original.
  ADD COLUMN "roster_loop" TEXT;

-- ── 3. Version-scope the identity of a question ─────────────────────────────
ALTER TABLE "questions" ALTER COLUMN "methodology_version_id" SET NOT NULL;

DROP INDEX IF EXISTS "questions_question_id_key";
CREATE UNIQUE INDEX "questions_methodology_version_id_question_id_key"
  ON "questions"("methodology_version_id", "question_id");
CREATE INDEX "questions_methodology_version_id_idx"
  ON "questions"("methodology_version_id");

-- The old FK action was ON DELETE SET NULL, which cannot hold now the column is
-- NOT NULL. RESTRICT is also the correct change-control semantics: a methodology
-- version that any question still belongs to must not be deletable — retire it
-- (status = 'RETIRED') instead.
ALTER TABLE "questions" DROP CONSTRAINT IF EXISTS "questions_methodology_version_id_fkey";
ALTER TABLE "questions"
  ADD CONSTRAINT "questions_methodology_version_id_fkey"
  FOREIGN KEY ("methodology_version_id") REFERENCES "methodology_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
