-- RIO Arabic Localization — Approach 3 (Hybrid), client-confirmed 2026-09-04.
-- Adds a nullable Arabic-text column next to the existing English column on
-- every configurable/master-data table, per arabic-localization-approach.md's
-- "Approach 1: Bilingual Storage" applied to fixed/configurable content.
-- Nullable everywhere, no default: existing English data keeps working
-- unchanged, Arabic simply displays once a value is filled in (English
-- fallback at the API layer).

ALTER TABLE "domains" ADD COLUMN "name_ar" VARCHAR(200);
ALTER TABLE "sub_domains" ADD COLUMN "name_ar" VARCHAR(200);

ALTER TABLE "study_type_options" ADD COLUMN "name_ar" VARCHAR(100);
ALTER TABLE "target_sector_options" ADD COLUMN "name_ar" VARCHAR(100);
ALTER TABLE "need_theme_options" ADD COLUMN "name_ar" VARCHAR(100);
ALTER TABLE "decision_type_options" ADD COLUMN "name_ar" VARCHAR(100);
ALTER TABLE "gap_type_options" ADD COLUMN "name_ar" VARCHAR(100);

ALTER TABLE "questions"
  ADD COLUMN "question_text_ar" TEXT,
  ADD COLUMN "answer_options_ar" JSONB,
  ADD COLUMN "indicator_ar" VARCHAR(200),
  ADD COLUMN "kpi_ar" VARCHAR(200);
