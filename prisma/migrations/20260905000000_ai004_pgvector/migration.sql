-- RIO-AI-004 / Q48 — move semantic comparison into Postgres.
--
-- ─── What this replaces ─────────────────────────────────────────────────────
-- `need_embeddings.vector` is JSONB, and SemanticDuplicateService pulls every
-- vector into Node and compares each pair in a doubly-nested loop. Measured:
-- 200 needs = 40ms, 1,000 needs = 1.1s over 499,500 pairs, and every vector
-- crosses the wire first. The literal pass already pushes its comparison into
-- the database via pg_trgm and four functional GIN indexes; this closes the
-- asymmetry.
--
-- Q48's own wording anticipated it: "It needs a vector index in the database".
--
-- ─── Why the JSONB column stays ─────────────────────────────────────────────
-- Both columns are kept and both are written. The service prefers the typed
-- column when the extension is present and falls back to JSONB when it is not,
-- so a deployment without pgvector keeps working rather than losing semantic
-- detection entirely. Dropping `vector` would make this migration irreversible
-- on any server where the extension cannot be installed — which today includes
-- the team's own Windows PostgreSQL, where `CREATE EXTENSION vector` reports
-- "extension \"vector\" is not available".
--
-- ─── Guarded, because the extension may genuinely be absent ─────────────────
-- Managed Postgres has allowlists and a Windows MSVC build needs the extension
-- compiled in. A migration that hard-fails there would block every later
-- migration for a feature that is an optimisation, not a requirement. So this
-- checks availability and skips with a notice.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE NOTICE 'pgvector is not available on this server. Skipping: semantic duplicate detection will continue to compare vectors in the application. Install pgvector and re-run this migration to enable the indexed path.';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS vector;

  -- 768 to match GeminiEmbeddingProvider.DIMENSIONS. A vector column is typed
  -- by dimension, so a provider change that alters this needs its own
  -- migration — which is correct: vectors of different width are not
  -- comparable, and the type should say so rather than failing at query time.
  ALTER TABLE "need_embeddings"
    ADD COLUMN IF NOT EXISTS "embedding" vector(768);

  -- Backfill from the JSONB already stored. `vector` accepts the same JSON
  -- array text form, so this is a cast rather than a re-embed: no API calls, no
  -- cost, and the values are identical to what the model returned.
  UPDATE "need_embeddings"
     SET "embedding" = "vector"::text::vector(768)
   WHERE "embedding" IS NULL
     AND jsonb_array_length("vector") = 768;

  -- HNSW rather than IVFFlat. IVFFlat must be built AFTER the table holds a
  -- representative sample and needs rebuilding as the data grows, which is a
  -- maintenance obligation nobody would remember. HNSW builds on an empty table
  -- and stays correct as rows arrive — the right trade for a table that starts
  -- at zero rows and grows slowly.
  --
  -- vector_cosine_ops because cosineSimilarity() in the application is cosine.
  -- Using a different operator class here would rank candidates differently
  -- from the code that scores them, which reads to a reviewer as the system
  -- contradicting itself.
  CREATE INDEX IF NOT EXISTS "need_embeddings_embedding_hnsw_idx"
    ON "need_embeddings" USING hnsw ("embedding" vector_cosine_ops);

  RAISE NOTICE 'pgvector enabled: need_embeddings.embedding populated and indexed.';
END $$;
