-- AlterTable
-- Need's own Governorate link is now multi-select (see
-- 20260722142433_need_multi_governorate) — the response snapshot follows
-- suit. No existing rows have this column set, so no backfill needed.
ALTER TABLE "survey_responses"
  DROP COLUMN "governorate_id",
  ADD COLUMN "governorate_ids" UUID[] DEFAULT ARRAY[]::UUID[];
