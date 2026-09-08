-- RIO-AI-004 — the merge engine.
--
-- FR-002 already proposes duplicate pairs and records a reviewer's decision on
-- them. This adds the act the client described in Q50/Q51: turning a confirmed
-- pair into one need, without losing anything attached to either.
--
-- Client-confirmed (Sprint 3 consolidated answers, 30 Aug 2026):
--   Q49  duplicate detection and merging operate on the ENTERED need — the
--        researcher's raw, pre-scoring entry. The computed severity rows are
--        explicitly excluded, which is why priority_scores is NOT in the
--        transfer set below.
--   Q50  everything transfers to the survivor — survey responses, evidence
--        files, AI classification decisions with their approvals, initiative
--        links — "each item keeping its original source recorded, so nothing
--        is double-counted or lost."
--   Q51  the survivor keeps its OWN internal reference number; the retired
--        number is kept permanently as an alias so old links and reports still
--        resolve; both external references are retained on the survivor.
--   Q24  published reports stay frozen, current scores recalculate, the merge
--        is logged, and undo is allowed with a mandatory note.
--
-- Their closing note on Q51 governs the whole design: "make sure no entry
-- overrides another one." Nothing here deletes a need or overwrites a value
-- that cannot be recovered.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A retired need is retired, never deleted
-- ─────────────────────────────────────────────────────────────────────────────

-- The presence of this column IS the merged state — deliberately not a new
-- NeedStatus enum value. Two reasons. Adding an enum value needs its own
-- migration (Postgres refuses to use one in the transaction that created it),
-- and more importantly a retired need should keep the workflow status it had
-- when it was retired: "this was a reviewer_approved need that turned out to
-- duplicate another" is a truer record than overwriting that with "merged".
--
-- Every list, count and score must exclude `merged_into_need_id IS NOT NULL`.
ALTER TABLE "needs" ADD COLUMN "merged_into_need_id" UUID;

ALTER TABLE "needs" ADD CONSTRAINT "needs_merged_into_need_id_fkey"
  FOREIGN KEY ("merged_into_need_id") REFERENCES "needs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT above, and this here: a need cannot be merged into itself, and the
-- service refuses a chain (merging into an already-retired need).
ALTER TABLE "needs" ADD CONSTRAINT "needs_not_merged_into_itself"
  CHECK ("merged_into_need_id" IS NULL OR "merged_into_need_id" <> "id");

-- Partial: the overwhelming majority of needs are not merged, and the queries
-- that care ask "what was merged into this survivor?".
CREATE INDEX "needs_merged_into_need_id_idx"
  ON "needs"("merged_into_need_id") WHERE "merged_into_need_id" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. need_merges — the decision, and what undo needs to reverse it
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "need_merges" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "org_id" UUID NOT NULL,
  "survivor_need_id" UUID NOT NULL,
  "retired_need_id" UUID NOT NULL,
  -- The candidate this merge acted on, when it came from the queue. Nullable
  -- and SET NULL: losing the proposal must never take the record of the merge
  -- with it, same reasoning as human_decisions.ai_suggestion_id.
  "candidate_id" UUID,
  -- Optional on merge, MANDATORY on undo — see the CHECK below. Confirming a
  -- merge is explained by the pair itself; reversing one is the act a later
  -- reader needs a reason for, which is the rule the client already applies to
  -- score overrides.
  "note" TEXT,
  "decided_by" UUID NOT NULL,
  "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "undone_by" UUID,
  "undone_at" TIMESTAMPTZ(6),
  "undo_note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "need_merges_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "need_merges" ADD CONSTRAINT "need_merges_survivor_need_id_fkey"
  FOREIGN KEY ("survivor_need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "need_merges" ADD CONSTRAINT "need_merges_retired_need_id_fkey"
  FOREIGN KEY ("retired_need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "need_merges" ADD CONSTRAINT "need_merges_candidate_id_fkey"
  FOREIGN KEY ("candidate_id") REFERENCES "duplicate_candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "need_merges" ADD CONSTRAINT "need_merges_two_distinct_needs"
  CHECK ("survivor_need_id" <> "retired_need_id");

-- Q24's "recommend allowing undo with a mandatory note", enforced rather than
-- remembered. An undo is either fully recorded — who, when, why — or it is not
-- an undo.
ALTER TABLE "need_merges" ADD CONSTRAINT "need_merges_undo_is_complete"
  CHECK (
    ("undone_by" IS NULL AND "undone_at" IS NULL AND "undo_note" IS NULL)
    OR ("undone_by" IS NOT NULL AND "undone_at" IS NOT NULL AND btrim(coalesce("undo_note", '')) <> '')
  );

-- A need can only be retired into one survivor at a time. Partial on the live
-- merges, so a need that was merged, undone, and merged again is fine.
CREATE UNIQUE INDEX "need_merges_one_live_per_retired_idx"
  ON "need_merges"("retired_need_id") WHERE "undone_at" IS NULL;

CREATE INDEX "need_merges_org_id_idx" ON "need_merges"("org_id");
CREATE INDEX "need_merges_survivor_need_id_idx" ON "need_merges"("survivor_need_id");

ALTER TABLE "need_merges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "need_merges" FORCE ROW LEVEL SECURITY;
CREATE POLICY need_merges_org_isolation ON "need_merges"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "need_merges" TO cnap_app;
GRANT SELECT ON "need_merges" TO cnap_supervisor;
CREATE POLICY need_merges_supervisor_read ON "need_merges" FOR SELECT TO cnap_supervisor USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. need_merge_transfers — Q50's "original source recorded against each item"
-- ─────────────────────────────────────────────────────────────────────────────

-- A LEDGER rather than a `merged_from_need_id` column on each of the twelve
-- tables a merge touches.
--
-- The plan called for the column-per-table shape. This is better for the same
-- job: one migration instead of twelve column additions across models that
-- have nothing else in common; undo reads the ledger directly instead of
-- twelve reverse queries; and "what moved in this merge" is one indexed lookup
-- rather than a union. Q50 asks that each item keep its original source
-- recorded — a row naming the item and where it came from does that exactly.
CREATE TABLE "need_merge_transfers" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "merge_id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  -- The table the row lives in, in Prisma model terms ("SurveyResponse",
  -- "Evidence", ...). Not a Postgres enum: the transfer set will grow when
  -- FR-021's initiative links land, and that should be a code change.
  "entity_type" VARCHAR(60) NOT NULL,
  "entity_id" UUID NOT NULL,
  -- Where it came from. Always the retired need for a merge, and what undo
  -- puts it back to.
  "from_need_id" UUID NOT NULL,
  "to_need_id" UUID NOT NULL,
  "transferred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "need_merge_transfers_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "need_merge_transfers" ADD CONSTRAINT "need_merge_transfers_merge_id_fkey"
  FOREIGN KEY ("merge_id") REFERENCES "need_merges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One row per item per merge. A retry that partially failed must not double up.
CREATE UNIQUE INDEX "need_merge_transfers_merge_id_entity_type_entity_id_key"
  ON "need_merge_transfers"("merge_id", "entity_type", "entity_id");
CREATE INDEX "need_merge_transfers_org_id_idx" ON "need_merge_transfers"("org_id");
CREATE INDEX "need_merge_transfers_merge_id_idx" ON "need_merge_transfers"("merge_id");

ALTER TABLE "need_merge_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "need_merge_transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY need_merge_transfers_org_isolation ON "need_merge_transfers"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON "need_merge_transfers" TO cnap_app;
GRANT SELECT ON "need_merge_transfers" TO cnap_supervisor;
CREATE POLICY need_merge_transfers_supervisor_read ON "need_merge_transfers" FOR SELECT TO cnap_supervisor USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. need_reference_aliases — Q51's retired number keeps working
-- ─────────────────────────────────────────────────────────────────────────────

-- "The retired number is kept permanently as an alias so old links/reports
-- still resolve." Permanently is the operative word: this row survives an undo
-- (see NeedMergeService.undo) precisely so a reference printed in a report
-- during the merged period never stops resolving.
CREATE TABLE "need_reference_aliases" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "org_id" UUID NOT NULL,
  -- The RETIRED need's internal_ref_seq — the number that used to identify a
  -- need of its own and now resolves to the survivor. Globally unique because
  -- internal_ref_seq is a global autoincrement, not per-org.
  "retired_internal_ref_seq" INTEGER NOT NULL,
  "retired_need_id" UUID NOT NULL,
  "need_id" UUID NOT NULL,
  "merge_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "need_reference_aliases_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "need_reference_aliases" ADD CONSTRAINT "need_reference_aliases_need_id_fkey"
  FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "need_reference_aliases" ADD CONSTRAINT "need_reference_aliases_merge_id_fkey"
  FOREIGN KEY ("merge_id") REFERENCES "need_merges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "need_reference_aliases_retired_internal_ref_seq_key"
  ON "need_reference_aliases"("retired_internal_ref_seq");
CREATE INDEX "need_reference_aliases_need_id_idx" ON "need_reference_aliases"("need_id");
CREATE INDEX "need_reference_aliases_org_id_idx" ON "need_reference_aliases"("org_id");

ALTER TABLE "need_reference_aliases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "need_reference_aliases" FORCE ROW LEVEL SECURITY;
CREATE POLICY need_reference_aliases_org_isolation ON "need_reference_aliases"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT ON "need_reference_aliases" TO cnap_app;
GRANT SELECT ON "need_reference_aliases" TO cnap_supervisor;
CREATE POLICY need_reference_aliases_supervisor_read ON "need_reference_aliases" FOR SELECT TO cnap_supervisor USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The survivor keeps BOTH external references (Q51)
-- ─────────────────────────────────────────────────────────────────────────────

-- needs.reference_id is the submitter's own external tracking id. A merge must
-- retain both sides' — "both external references are retained on the survivor"
-- — and the survivor already has its own column, so the retired one lands
-- here rather than overwriting anything. An array because a survivor can
-- absorb more than one need over time.
--
-- Not a merge of the two strings into reference_id: that column is what the
-- submitter's own records say, and appending to it would corrupt a value other
-- systems match on.
ALTER TABLE "needs" ADD COLUMN "absorbed_reference_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. need_embeddings — the semantic pass, built dark (Q48, blocked by Q10)
-- ─────────────────────────────────────────────────────────────────────────────

-- The client accepted meaning-based matching "as the right design" but blocked
-- the BUILD pending the AI-provider and residency ruling in Q10. The table is
-- created now so the schema is settled and the provider adapter is the only
-- thing left; nothing writes to it until the flag is on.
--
-- The vector is JSONB, not pgvector: enabling an extension on the client's
-- instance is their decision, not one to make inside a migration, and at pilot
-- scale in-process cosine over a few thousand rows is not the bottleneck. The
-- column type is the one thing that would change if pgvector is approved —
-- flagged in the tracker as an open decision.
CREATE TABLE "need_embeddings" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "org_id" UUID NOT NULL,
  "need_id" UUID NOT NULL,
  -- SHA-256 of the folded title+statement the vector was generated from.
  -- Regeneration is driven by this changing, which is the per-edit cost the
  -- client was warned about in Q48.
  "text_hash" VARCHAR(64) NOT NULL,
  "model_name" VARCHAR(150) NOT NULL,
  "embedding_version" VARCHAR(64) NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "vector" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "need_embeddings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "need_embeddings" ADD CONSTRAINT "need_embeddings_need_id_fkey"
  FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One vector per need per embedding version: a model change produces a new
-- row rather than silently replacing vectors built by a different model.
CREATE UNIQUE INDEX "need_embeddings_need_id_embedding_version_key"
  ON "need_embeddings"("need_id", "embedding_version");
CREATE INDEX "need_embeddings_org_id_idx" ON "need_embeddings"("org_id");

ALTER TABLE "need_embeddings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "need_embeddings" FORCE ROW LEVEL SECURITY;
CREATE POLICY need_embeddings_org_isolation ON "need_embeddings"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "need_embeddings" TO cnap_app;
GRANT SELECT ON "need_embeddings" TO cnap_supervisor;
CREATE POLICY need_embeddings_supervisor_read ON "need_embeddings" FOR SELECT TO cnap_supervisor USING (true);
