-- RIO-FR-002 — Data Cleaning, Standardization & Duplicate Detection.
--
-- Client-confirmed (Sprint 3 consolidated answers, 30 Aug 2026):
--   Q11  duplicates are PROPOSED, never merged automatically. Nothing in this
--        migration lets a detector mutate a Need: it can only write a
--        candidate row that a human then decides on.
--   Q12  five standardization targets, nothing to add — village/place names
--        against the geographic reference, dates to one format, mobile
--        numbers to one international format, numeric units per the question
--        bank, domain/sub-domain restricted to the methodology list.
--   Q13  "missing" and "low confidence" are SEPARATE rules. This migration
--        does not touch response_quality_results' existing thresholds; the
--        missing-field rule set is new and independent. "Don't know" is a
--        real answer excluded from scoring, not a gap (LIV-21) — configurable
--        below, because the client asked us to confirm before making it
--        platform-wide.
--   Q14  cleaning applies to all three sources (manual entry, survey
--        responses, imported spreadsheet rows) under ONE rule set, with a
--        report per source. Hence `source` on both the run and the flag.
--   Q40  ONE shared reviewer queue for FR-002's literal candidates and
--        RIO-AI-004's semantic ones. `duplicate_candidates` is created here,
--        with `method` and `scope` already in place, so AI-004 adds rows to
--        an existing queue rather than a second table and a second screen.
--   Q9   cross-entity duplicate candidates may only ever be seen by the
--        Center / NCNP Supervisor role (NFR-003, RIO-RBAC-002). Enforced in
--        the RLS policy below, not just in the service layer.
--
-- Additive only. No existing column changes type or nullability, and the two
-- new methodology-config columns are NOT NULL with a default, so every row
-- that exists today keeps working untouched.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Arabic-aware text folding
-- ─────────────────────────────────────────────────────────────────────────────

-- Village names are free text and the same village is spelled several ways
-- (the client said so themselves in Q2, about the coordinate file). The same
-- is true of need titles and statements. Every comparison in FR-002 — village
-- resolution against the geographic reference, and literal duplicate
-- detection — therefore runs on a FOLDED form of the text, not the raw form.
--
-- Folding lives in the database rather than only in TypeScript for one
-- reason: a functional GIN/trigram index can only exist over an IMMUTABLE SQL
-- function, and without those indexes candidate generation degrades to a
-- sequential scan over every need in the org. The TypeScript normalizer in
-- src/modules/data-cleaning MUST produce byte-identical output to this
-- function; a shared fixture test pins the two together.
--
-- What it removes/normalizes:
--   * Arabic diacritics (fatha, damma, kasra, shadda, sukun, tanween, dagger
--     alef) and tatweel — decorative, never distinguishing.
--   * Alef forms  أ إ آ ٱ  → ا      (the single most common spelling variance)
--   * Alef maqsura ى → ي,  ta marbuta ة → ه,  hamza carriers ؤ → و, ئ → ي
--   * Arabic-Indic digits ٠-٩ → 0-9, so "10" and "١٠" compare equal
--   * Punctuation → space, runs of whitespace → one space, trimmed, lowercased
--
-- translate() with a shorter `to` string DELETES the surplus `from`
-- characters, which is how the diacritics are stripped in one pass.
CREATE OR REPLACE FUNCTION rio_fold_text(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(
        translate(
          translate(lower(input), 'ًٌٍَُِّْٰـ', ''),
          'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩',
          'اااايهوي0123456789'
        ),
        '[[:punct:]]+', ' ', 'g'
      ),
      '\s+', ' ', 'g'
    )
  );
$$;

COMMENT ON FUNCTION rio_fold_text(text) IS
  'RIO-FR-002. Orthographic folding for Arabic/English comparison. Must stay byte-identical to foldText() in src/modules/data-cleaning — functional indexes depend on it being IMMUTABLE, so any change needs a REINDEX, not just a redeploy.';

-- Literal duplicate detection (Q11/Q40) compares folded title + statement.
-- Without these, every candidate-generation pass is a sequential scan.
CREATE INDEX "needs_title_folded_trgm_idx"
  ON "needs" USING GIN (rio_fold_text("title") gin_trgm_ops);

CREATE INDEX "needs_statement_folded_trgm_idx"
  ON "needs" USING GIN (rio_fold_text("statement") gin_trgm_ops);

-- Village/place resolution (Q12) matches free-text village strings against
-- the seeded geographic reference. Exact match first, then folded, then
-- trigram near-match — this index serves the third tier.
CREATE INDEX "centers_name_folded_trgm_idx"
  ON "centers" USING GIN (rio_fold_text("name") gin_trgm_ops);

CREATE INDEX "governorates_name_folded_trgm_idx"
  ON "governorates" USING GIN (rio_fold_text("name") gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. cleaning_runs — one pass over one source (AC 1's per-source report)
-- ─────────────────────────────────────────────────────────────────────────────

-- Q14 asked for "a report per source showing what was flagged". A run is that
-- report's row: what was scanned, under which rule-set version, and what came
-- out. Inline cleaning (a single Need saved on the need-entry form) writes a
-- run with scope_type = 'record' rather than being exempted, so the per-source
-- totals stay complete — a rule that only ever fires on bulk imports would
-- make the manual-entry column read as clean when it is merely unmeasured.
CREATE TABLE "cleaning_runs" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "org_id" UUID NOT NULL,
  -- 'manual_entry' | 'survey_response' | 'file_upload' — deliberately the
  -- same vocabulary as needs.source (the NeedSource enum) so a per-source
  -- report can be read against need counts without a translation table.
  -- VARCHAR rather than an enum, matching needs.urgency/needs.gap_type: the
  -- allowed set is validated in the contract layer, so adding the citizen
  -- channel later is a contract change, not a migration.
  "source" VARCHAR(30) NOT NULL,
  -- 'org' | 'study' | 'import_batch' | 'record'
  "scope_type" VARCHAR(20) NOT NULL,
  "study_id" UUID,
  -- Which version of the rule set produced these flags. A flag raised under
  -- an older rule set must stay readable as what it was — retuning a
  -- threshold never rewrites history (the same principle the client set for
  -- duplicate thresholds in Q23).
  "rule_set_version" VARCHAR(50) NOT NULL,
  "records_scanned" INTEGER NOT NULL DEFAULT 0,
  "records_flagged" INTEGER NOT NULL DEFAULT 0,
  "flags_raised" INTEGER NOT NULL DEFAULT 0,
  "status" VARCHAR(20) NOT NULL DEFAULT 'running',
  "error" TEXT,
  -- NULL when the run was triggered by the system on save/import rather than
  -- by a person clicking "run cleaning".
  "triggered_by" UUID,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "finished_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "cleaning_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cleaning_runs_org_id_idx" ON "cleaning_runs"("org_id");
CREATE INDEX "cleaning_runs_study_id_idx" ON "cleaning_runs"("study_id");
-- The per-source report's own query: newest runs for one source.
CREATE INDEX "cleaning_runs_org_id_source_started_at_idx"
  ON "cleaning_runs"("org_id", "source", "started_at" DESC);

ALTER TABLE "cleaning_runs" ADD CONSTRAINT "cleaning_runs_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cleaning_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cleaning_runs" FORCE ROW LEVEL SECURITY;

CREATE POLICY cleaning_runs_org_isolation ON "cleaning_runs"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON "cleaning_runs" TO cnap_app;
GRANT SELECT ON "cleaning_runs" TO cnap_supervisor;

CREATE POLICY cleaning_runs_supervisor_read ON "cleaning_runs" FOR SELECT TO cnap_supervisor USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. cleaning_flags — AC 1 (missing detected/flagged), AC 2 (formats
--    standardized) and AC 4 (reviewer decision logged), in one row shape
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per issue found on one field of one record. A flag is a PROPOSAL:
-- original_value is what is stored today, proposed_value is what the
-- normalizer would write instead, and nothing changes until a reviewer
-- accepts it. That is the same propose-only discipline Q11 set for
-- duplicates, applied to standardization — the client's "AI & Human Review"
-- principle does not stop at the duplicate queue.
--
-- entity_type/entity_id is deliberately polymorphic with no foreign key: a
-- flag can point at a Need, a SurveyResponse, one ResponseAnswer, or at an
-- import row that was never persisted at all (entity_id NULL, row_number
-- set). It is also a decision log — a flag whose need was later deleted is
-- still a true record that someone reviewed something, so cascading it away
-- would erase part of the audit trail AC 4 exists to keep.
CREATE TABLE "cleaning_flags" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "org_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  -- Denormalized from the run so the per-source report never joins, and so a
  -- flag stays self-describing. Same self-contained pattern as
  -- need_domains.org_id.
  "source" VARCHAR(30) NOT NULL,
  "study_id" UUID,
  -- 'need' | 'survey_response' | 'response_answer' | 'import_row'
  "entity_type" VARCHAR(40) NOT NULL,
  "entity_id" UUID,
  -- 1-based row number within the uploaded file. Set only for
  -- entity_type = 'import_row', where there is no persisted record to point
  -- at yet and the uploader needs to be told WHICH row.
  "row_number" INTEGER,
  -- The field the rule fired on, in the Prisma field name the API uses
  -- ('village', 'mobile', 'domain', ...), or the question code for an answer.
  "field" VARCHAR(120) NOT NULL,
  -- Stable machine code for the rule, e.g. 'MISSING_REQUIRED',
  -- 'VILLAGE_UNMATCHED', 'VILLAGE_NEAR_MATCH', 'DATE_FORMAT',
  -- 'PHONE_FORMAT', 'UNIT_MISMATCH', 'DOMAIN_NOT_IN_METHODOLOGY'. Codes are
  -- the API contract; the human-readable label is looked up per locale on
  -- the frontend, never stored here (this table must not need a migration to
  -- fix a typo in Arabic copy).
  "rule_code" VARCHAR(60) NOT NULL,
  -- 'missing' | 'non_standard' | 'out_of_vocabulary'
  "severity" VARCHAR(30) NOT NULL,
  "original_value" TEXT,
  "proposed_value" TEXT,
  -- 0..1 for a fuzzy proposal (a near-matched village name); NULL when the
  -- proposal is deterministic (a date reformat is not a guess).
  "confidence" NUMERIC(5, 4),
  -- Rule-specific context the reviewer needs and the code should not have to
  -- recompute — e.g. the top N candidate centers with their scores and codes
  -- for a VILLAGE_NEAR_MATCH.
  "detail" JSONB,
  -- 'pending' | 'accepted' | 'rejected' | 'superseded'.
  -- 'superseded' is set by a later run when the underlying value changed
  -- before anyone reviewed the flag — never deleted, so the queue shrinks
  -- without the record of what was once wrong disappearing.
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "reviewed_by" UUID,
  "reviewed_at" TIMESTAMPTZ(6),
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "cleaning_flags_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "cleaning_flags" ADD CONSTRAINT "cleaning_flags_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "cleaning_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AC 4 is "reviewer decision is logged". A decided flag with no decider is
-- exactly the hole that criterion exists to close, so it is enforced here as
-- well as in the service — same reasoning as priority_scores' override/reason
-- constraint (RIO-FR-003).
ALTER TABLE "cleaning_flags" ADD CONSTRAINT "cleaning_flags_decision_needs_reviewer"
  CHECK (
    ("status" IN ('pending', 'superseded') AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL)
    OR ("status" IN ('accepted', 'rejected') AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  );

-- A missing value has nothing to propose in its place — a rule that both
-- reports a field as absent and supplies a value for it is inventing data,
-- which is the one thing cleaning must never do.
ALTER TABLE "cleaning_flags" ADD CONSTRAINT "cleaning_flags_missing_has_no_proposal"
  CHECK ("severity" <> 'missing' OR "proposed_value" IS NULL);

-- An import row identifies itself by row number; everything else identifies
-- itself by id. Neither is optional for its own kind.
ALTER TABLE "cleaning_flags" ADD CONSTRAINT "cleaning_flags_target_identified"
  CHECK (
    ("entity_type" = 'import_row' AND "row_number" IS NOT NULL)
    OR ("entity_type" <> 'import_row' AND "entity_id" IS NOT NULL)
  );

CREATE INDEX "cleaning_flags_org_id_idx" ON "cleaning_flags"("org_id");
CREATE INDEX "cleaning_flags_run_id_idx" ON "cleaning_flags"("run_id");
CREATE INDEX "cleaning_flags_entity_type_entity_id_idx" ON "cleaning_flags"("entity_type", "entity_id");
-- The reviewer queue's own query: this org's open flags for one source,
-- oldest first. Partial, because a resolved flag is never in the queue and
-- resolved rows will outnumber open ones by orders of magnitude.
CREATE INDEX "cleaning_flags_open_queue_idx"
  ON "cleaning_flags"("org_id", "source", "created_at")
  WHERE "status" = 'pending';

-- Re-running cleaning over the same record must UPDATE the open flag rather
-- than stack a second identical one on the reviewer's queue. Partial unique
-- so the history of previously-decided flags on the same field is unaffected.
CREATE UNIQUE INDEX "cleaning_flags_one_open_per_field_idx"
  ON "cleaning_flags"("entity_type", "entity_id", "field", "rule_code")
  WHERE "status" = 'pending' AND "entity_id" IS NOT NULL;

ALTER TABLE "cleaning_flags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cleaning_flags" FORCE ROW LEVEL SECURITY;

CREATE POLICY cleaning_flags_org_isolation ON "cleaning_flags"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON "cleaning_flags" TO cnap_app;
GRANT SELECT ON "cleaning_flags" TO cnap_supervisor;

CREATE POLICY cleaning_flags_supervisor_read ON "cleaning_flags" FOR SELECT TO cnap_supervisor USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. duplicate_candidates — the shared queue of Q40
-- ─────────────────────────────────────────────────────────────────────────────

-- FR-002 fills this with `method = 'literal'` rows. RIO-AI-004 adds
-- `method = 'semantic'` rows and the merge action; the reviewer sees one
-- queue either way, which is what the client asked for in Q40.
--
-- NOTHING here mutates a Need. Confirming a duplicate sets `status` and
-- (in AI-004) writes a separate need_merges row — Q11's "propose-only, never
-- automatic" is a property of the schema, not a convention in a service.
CREATE TABLE "duplicate_candidates" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  -- NULL for scope = 'cross_org'. See the RLS policy below: this is what
  -- keeps one entity's need text away from another entity's reviewers
  -- (Q9 / NFR-003), enforced by Postgres rather than by remembering to add a
  -- WHERE clause in every query.
  "org_id" UUID,
  "need_a_id" UUID NOT NULL,
  "need_b_id" UUID NOT NULL,
  -- Kept alongside the pair so the Center/NCNP queue can label which entity
  -- each side belongs to without joining across an RLS boundary it cannot
  -- read from.
  "need_a_org_id" UUID NOT NULL,
  "need_b_org_id" UUID NOT NULL,
  -- 'within_study' | 'within_org' | 'cross_org' (Q9)
  "scope" VARCHAR(20) NOT NULL,
  -- 'literal' (FR-002) | 'semantic' (AI-004, Q48). The reviewer is shown
  -- which pass proposed the pair, because the two warrant different scrutiny.
  "method" VARCHAR(20) NOT NULL,
  -- Similarity 0..1.
  "score" NUMERIC(5, 4) NOT NULL,
  -- The threshold in force WHEN THIS ROW WAS RAISED. Q23 has the threshold
  -- starting conservative and being tuned once real field data exists;
  -- storing it per row means retuning changes what is proposed next, never
  -- what was already proposed and decided.
  "threshold" NUMERIC(5, 4) NOT NULL,
  "detector_version" VARCHAR(50) NOT NULL,
  -- AI-004 only: the stored AiSuggestion behind a semantic proposal, so
  -- "AI suggestion and human decision stored" (AI-004 AC 2) resolves to real
  -- rows. SET NULL, not CASCADE — losing the suggestion must not take the
  -- reviewer's decision down with it, same reasoning as
  -- human_decisions.ai_suggestion_id.
  "ai_suggestion_id" UUID,
  -- 'pending' | 'confirmed_duplicate' | 'not_duplicate' | 'merged' | 'dismissed'
  "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
  "reviewed_by" UUID,
  "reviewed_at" TIMESTAMPTZ(6),
  "note" TEXT,
  "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "duplicate_candidates_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_need_a_id_fkey"
  FOREIGN KEY ("need_a_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_need_b_id_fkey"
  FOREIGN KEY ("need_b_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_ai_suggestion_id_fkey"
  FOREIGN KEY ("ai_suggestion_id") REFERENCES "ai_suggestions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A pair is unordered: (A,B) and (B,A) are the same proposal and must not
-- both sit in the queue. Storing them ordered makes the unique index below
-- sufficient on its own, with no second lookup on every insert.
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_ordered_pair"
  CHECK ("need_a_id" < "need_b_id");

-- Q9, restated as an invariant: a cross-org candidate belongs to no single
-- org and an org-scoped one always names its org. The RLS policy relies on
-- this holding, so it is a constraint and not a comment.
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_cross_org_has_no_owner"
  CHECK (("scope" = 'cross_org') = ("org_id" IS NULL));

ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_decision_needs_reviewer"
  CHECK (
    ("status" = 'pending' AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL)
    OR ("status" <> 'pending' AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  );

CREATE UNIQUE INDEX "duplicate_candidates_need_a_id_need_b_id_method_key"
  ON "duplicate_candidates"("need_a_id", "need_b_id", "method");

CREATE INDEX "duplicate_candidates_org_id_idx" ON "duplicate_candidates"("org_id");
CREATE INDEX "duplicate_candidates_need_a_id_idx" ON "duplicate_candidates"("need_a_id");
CREATE INDEX "duplicate_candidates_need_b_id_idx" ON "duplicate_candidates"("need_b_id");
-- The queue: open candidates, strongest match first.
CREATE INDEX "duplicate_candidates_open_queue_idx"
  ON "duplicate_candidates"("org_id", "score" DESC)
  WHERE "status" = 'pending';

ALTER TABLE "duplicate_candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "duplicate_candidates" FORCE ROW LEVEL SECURITY;

-- The Q9 rule in one expression.
--
-- IS NOT DISTINCT FROM treats NULL = NULL as true, which splits this table
-- cleanly in two along the connection's org context:
--   * an org-scoped connection (app.current_org_id set — every ordinary
--     request, via TenantPrismaService.runInOrgContext) sees ONLY its own
--     org's candidates. Cross-org rows have org_id NULL and are invisible to
--     it for select, update and insert alike — an NGO reviewer cannot reach
--     another entity's need text even with a hand-written query.
--   * a no-GUC connection (TenantPrismaService.runAsSupervisorWrite, reached
--     only behind the crossEntity RBAC guard) sees ONLY the cross-org rows.
--     That is the Center / NCNP Supervisor's write path for recording a
--     decision, which the SELECT-only cnap_supervisor role cannot perform.
--
-- The read path for the Center's queue is the cnap_supervisor policy below.
CREATE POLICY duplicate_candidates_org_isolation ON "duplicate_candidates"
  USING (org_id IS NOT DISTINCT FROM NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id IS NOT DISTINCT FROM NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON "duplicate_candidates" TO cnap_app;
GRANT SELECT ON "duplicate_candidates" TO cnap_supervisor;

CREATE POLICY duplicate_candidates_supervisor_read ON "duplicate_candidates" FOR SELECT TO cnap_supervisor USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The rule set itself — configuration, not constants
-- ─────────────────────────────────────────────────────────────────────────────

-- Deliberately NOT a new settings table. methodology_configs is already the
-- single mutable row that owns confidence_flag_settings (the Q13 statistical
-- flag this must stay separate from), ai_classification_settings and
-- ai_summary_settings, and methodology_config_history already snapshots every
-- change under RIO-NFR-017's "never overwrite" rule with a System Reviewer
-- approval gate in front of it. Cleaning thresholds are methodology rules and
-- belong in the same place, on the same screen, under the same sign-off.
--
-- The history column is added alongside it for the reason the FR-003 comment
-- gives: a history row that silently omits the only thing that changed is
-- worse than no history row.
ALTER TABLE "methodology_configs" ADD COLUMN "data_cleaning_settings" JSONB
  NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "methodology_config_history" ADD COLUMN "data_cleaning_settings" JSONB
  NOT NULL DEFAULT '{}'::jsonb;

-- Seeded so cleaning works on day one, then editable — same approach as
-- priority_factor_scales.
--
-- dontKnowTreatment: Q13. 'excluded_answer' is the ratified LIV-21 treatment
--   ("Prefer not to answer" is coded DK/NA and excluded from scoring, not
--   treated as a gap to fill). The client asked us to CONFIRM before making
--   it platform-wide, so it is a setting with the expected answer as its
--   default: if they come back with 'missing_value', that is a settings
--   change on an admin screen, not a migration.
-- villageMatchProposeThreshold / villageMatchAcceptThreshold: a match at or
--   above the accept threshold is still only PROPOSED (nothing auto-writes);
--   the two thresholds separate "offer this one" from "offer a shortlist".
-- literalDuplicateThreshold: Q23 — start conservative so reviewers see few
--   false alarms, tune once real field data exists.
-- crossOrg is false: cross-entity comparison arrives with AI-004 and is a
--   deliberate act by the Center, not something that switches itself on.
UPDATE "methodology_configs"
SET "data_cleaning_settings" = '{
  "ruleSetVersion": "fr002-v1",
  "dontKnowTreatment": "excluded_answer",
  "requiredNeedFields": ["title", "statement", "domain", "geography", "source"],
  "softNeedFields": ["affectedPopulation", "urgency", "gapType"],
  "requiredSurveyResponseFields": ["contact", "village"],
  "dateOutputFormat": "YYYY-MM-DD",
  "phoneDefaultRegion": "SA",
  "phoneOutputFormat": "E164",
  "villageMatchAcceptThreshold": 0.92,
  "villageMatchProposeThreshold": 0.75,
  "villageMatchMaxCandidates": 5,
  "literalDuplicateThreshold": 0.85,
  "duplicateScopes": { "withinStudy": true, "withinOrg": true, "crossOrg": false }
}'::jsonb
WHERE "data_cleaning_settings" = '{}'::jsonb;
