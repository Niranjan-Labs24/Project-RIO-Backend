-- RIO-FR-013 (client feedback 2026-09-04) — the historical study upload
-- form's region field should be a proper Region -> Governorate -> Center
-- picker sourced from the KSA Geographic Reference, not free text.

ALTER TABLE "historical_studies"
  ADD COLUMN "governorate_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  ADD COLUMN "center_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
