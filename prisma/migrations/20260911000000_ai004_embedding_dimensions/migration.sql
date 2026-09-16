-- RIO-AI-004 / Q10 — retype the vector column for the ruled provider.
--
-- ─── Why this migration exists ──────────────────────────────────────────────
-- Q10 named OCI Cohere. Embedding therefore moves from Gemini's
-- gemini-embedding-001 at 768 dimensions to cohere.embed-multilingual-v3.0 at
-- 1024, and 20260905000000 declared `need_embeddings.embedding` as vector(768).
--
-- That migration's own comment called this: "a provider change that alters
-- this needs its own migration — which is correct: vectors of different width
-- are not comparable, and the type should say so rather than failing at query
-- time." This is that migration.
--
-- ─── DROP and re-ADD rather than ALTER TYPE ─────────────────────────────────
-- `ALTER COLUMN ... TYPE vector(1024)` has to cast every existing value, and
-- every existing value is 768 wide, so it fails on any database that has run a
-- scan. Dropping the column discards only a DERIVED copy: `need_embeddings.
-- vector` (JSONB) holds the same numbers, and 20260905000000 populated the
-- typed column by casting from it, not by re-embedding. Nothing is lost that
-- was paid for.
--
-- ─── The 768-dimension rows are left in place ───────────────────────────────
-- Deliberately not deleted. SemanticDuplicateService reads only rows matching
-- the CURRENT embeddingVersion, so Gemini vectors are already invisible to it;
-- they cost a little storage and are the only evidence of what this deployment
-- compared before the switch. Deleting data is not this migration's job.
--
-- ─── Switching back to Gemini does not need a migration ─────────────────────
-- hasPgvector() compares the column's declared width against the provider's
-- and falls back to comparing in the application when they disagree, the same
-- path a server without pgvector takes. So a deployment that sets
-- AI_PROVIDER=gemini against this column keeps working — unindexed, and
-- saying so in the log — rather than failing every scan.
--
-- ─── Guarded, for the same reason 20260905000000 was ────────────────────────
-- pgvector is genuinely absent on some of these servers (the team's own
-- Windows PostgreSQL among them). There the column was never created, there is
-- nothing to retype, and this must skip rather than block every later
-- migration for what is an optimisation.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE NOTICE 'pgvector is not installed here, so need_embeddings.embedding does not exist. Skipping: semantic duplicate detection compares vectors in the application on this server.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'need_embeddings' AND column_name = 'embedding'
  ) THEN
    RAISE NOTICE 'need_embeddings.embedding is absent. Skipping.';
    RETURN;
  END IF;

  -- The index is typed through the column, so it goes first and is rebuilt
  -- below. HNSW builds on an empty table and stays correct as rows arrive,
  -- which is why rebuilding it here costs nothing on a cold database.
  DROP INDEX IF EXISTS "need_embeddings_embedding_hnsw_idx";

  ALTER TABLE "need_embeddings" DROP COLUMN "embedding";
  ALTER TABLE "need_embeddings" ADD COLUMN "embedding" vector(1024);

  -- Backfill anything already stored at the new width. On a database that has
  -- not yet run a scan under the new provider this matches nothing, and the
  -- next scan's populate step fills it — see refreshEmbeddings, which casts
  -- from the JSONB rather than sending the floats a second time.
  UPDATE "need_embeddings"
     SET "embedding" = "vector"::text::vector(1024)
   WHERE "embedding" IS NULL
     AND jsonb_array_length("vector") = 1024;

  -- vector_cosine_ops, because cosineSimilarity() in the application is
  -- cosine. A different operator class would rank candidates differently from
  -- the code that scores them, which reads to a reviewer as the system
  -- contradicting itself.
  CREATE INDEX IF NOT EXISTS "need_embeddings_embedding_hnsw_idx"
    ON "need_embeddings" USING hnsw ("embedding" vector_cosine_ops);

  RAISE NOTICE 'need_embeddings.embedding is now vector(1024) and indexed. Existing 768-dimension rows are retained in the JSONB column and ignored by the current embedding version.';
END $$;
