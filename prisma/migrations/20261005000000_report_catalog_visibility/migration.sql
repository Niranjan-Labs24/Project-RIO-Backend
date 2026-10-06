-- Report Catalog visibility (client recommendation 2026-10-05, pending
-- client confirmation; the UI controls stay hidden until then).
-- Organisation-level default: list approved reports in the catalog.
ALTER TABLE "organisations" ADD COLUMN "catalog_default_visible" BOOLEAN NOT NULL DEFAULT true;
-- Per-report override; NULL follows the organisation default.
ALTER TABLE "reports" ADD COLUMN "catalog_visible" BOOLEAN;
