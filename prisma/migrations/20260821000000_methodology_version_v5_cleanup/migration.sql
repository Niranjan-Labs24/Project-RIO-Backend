-- Client-confirmed (RIO Basira Consolidated BRD & Methodology v5.0, final):
-- v5.0 ("Village Needs Methodology V5.0") is the current, approved, final
-- methodology. v1.0 is a superseded legacy bank kept only for
-- reproducibility by prisma/import-questions.ts and
-- prisma/import-scoring-lookups.ts — it should never have been left
-- selectable as an equal, currently-published alternative.

-- 1. The single-row methodology_configs settings label was seeded once by
--    the very first schema migration (20260716093000) at "v1.0 - Approved
--    implementation baseline" and never updated, even though the real
--    imported question bank underneath it has been v5.0 for a while.
--    Guarded so this is a one-shot backfill: an environment whose label was
--    already hand-corrected is left alone, and re-running is a no-op.
UPDATE "methodology_configs"
SET "version" = 'v5.0 - Approved methodology baseline'
WHERE "version" = 'v1.0 - Approved implementation baseline';

-- 2. The legacy v1.0 MethodologyVersion row was marked PUBLISHED at
--    creation time by import-questions.ts/import-scoring-lookups.ts (see
--    their own updated comments), so it sat selectable right alongside the
--    real v5.0 baseline in Study creation and Survey Builder. RETIRED
--    (not DRAFT) because it genuinely was published and used historically —
--    this is a retirement, not walking back an approval that never
--    happened. Any Study/Survey already explicitly linked to it by version
--    string is unaffected: those lookups match on `version`, not `status`.
--    Guarded to only touch the legacy row, and only while still PUBLISHED,
--    so this is also a one-shot, idempotent backfill.
UPDATE "methodology_versions"
SET "status" = 'RETIRED'
WHERE "version" = 'v1.0 - Approved implementation baseline'
  AND "status" = 'PUBLISHED';
