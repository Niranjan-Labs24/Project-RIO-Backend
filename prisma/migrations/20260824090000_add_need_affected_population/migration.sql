-- RIO-RPT-001 Option A (client-confirmed 24 Aug 2026): capture "roughly how
-- many people does this need affect?" at need entry, so the Top-Priority
-- Report's Affected Population column has a real per-need source instead of
-- rendering a dash on every row.
--
-- Nullable with no backfill and no DEFAULT — on purpose. The figure was never
-- asked for on any earlier entry path, so it cannot be reconstructed for Needs
-- already recorded; Study.population is the study AREA's population and would
-- assert that every need affects everyone. Existing rows stay NULL and keep
-- printing "—" with the reason stated on the report.
ALTER TABLE "needs" ADD COLUMN "affected_population" INTEGER;

-- A count of people: never negative. Rejected at the API layer too
-- (CreateNeedBody/UpdateNeedBody), this is the backstop for the import path
-- and for anything writing SQL directly.
ALTER TABLE "needs" ADD CONSTRAINT "needs_affected_population_non_negative"
  CHECK ("affected_population" IS NULL OR "affected_population" >= 0);
