-- RIO-DATA-002 / FR-17 — import the Center's prior study into the unified
-- dashboard (explicitly NOT an external BI link, and not just a downloadable
-- attachment either: the *needs inside* the old file have to become real
-- Need rows so the dashboard, filters and FR-003 priority scoring all apply
-- to them unchanged).
--
-- RIO-FR-013 already stores the pre-platform file + its metadata in
-- `historical_studies`. That table is deliberately append-only (no UPDATE
-- policy, no UPDATE grant — client Q27, archive entries are permanent), so
-- the link between an archive entry and the Study produced from it is held
-- on the `studies` side rather than by mutating the archive row.

ALTER TABLE "studies"
  -- Marks a Study that represents a pre-platform study rather than a cycle
  -- run on the platform. Drives the unified dashboard's historical/current
  -- split and the comparison view.
  ADD COLUMN "is_historical" BOOLEAN NOT NULL DEFAULT false,
  -- When the original study was actually conducted. `created_at` is the
  -- *import* date, which is useless for comparing 2023 against 2026.
  ADD COLUMN "historical_study_date" DATE,
  -- The archive entry this Study was imported from. UNIQUE enforces
  -- "import once" at the database level rather than only in service code.
  ADD COLUMN "historical_study_id" UUID;

ALTER TABLE "studies" ADD CONSTRAINT "studies_historical_study_id_key" UNIQUE ("historical_study_id");

ALTER TABLE "studies" ADD CONSTRAINT "studies_historical_study_id_fkey"
  FOREIGN KEY ("historical_study_id") REFERENCES "historical_studies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Dashboard queries split on this flag, so index it alongside the existing
-- org_id index rather than relying on a sequential scan per dashboard load.
CREATE INDEX "studies_org_id_is_historical_idx" ON "studies"("org_id", "is_historical");
