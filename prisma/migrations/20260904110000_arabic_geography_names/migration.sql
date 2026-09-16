-- RIO Arabic Localization — Approach 3 (Hybrid), client-confirmed 2026-09-04.
-- Adds a nullable Arabic-name column to the KSA Geographic Reference tables,
-- sourced from the client-supplied ENRICHED workbook (see
-- prisma/import-arabic-geography.ts).

ALTER TABLE "regions" ADD COLUMN "name_ar" VARCHAR(150);
ALTER TABLE "governorates" ADD COLUMN "name_ar" VARCHAR(150);
ALTER TABLE "centers" ADD COLUMN "name_ar" VARCHAR(150);
