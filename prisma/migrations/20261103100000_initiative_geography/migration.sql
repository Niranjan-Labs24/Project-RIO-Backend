-- UAT INI-01 — an initiative's geographic scope is picked from the same
-- Region > Governorate > Centre reference as a Study, instead of free text.
-- Additive: existing initiatives keep their free-text `geography` and get
-- empty lists here.
ALTER TABLE "initiatives" ADD COLUMN IF NOT EXISTS "region_ids" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "initiatives" ADD COLUMN IF NOT EXISTS "governorate_ids" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "initiatives" ADD COLUMN IF NOT EXISTS "center_ids" UUID[] NOT NULL DEFAULT '{}';
