-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other', 'prefer_not_to_say');

-- AlterTable
-- Geography snapshot (region_id/governorate_id/center_ids/village) is a
-- pure denormalized copy taken from the Need/Organization at submission
-- time — no FK relation, same as Need.governorateId's own established
-- pattern. All nullable/defaulted so existing rows need no backfill.
ALTER TABLE "survey_responses"
  ADD COLUMN "gender" "Gender",
  ADD COLUMN "region_id" UUID,
  ADD COLUMN "governorate_id" UUID,
  ADD COLUMN "center_ids" UUID[] DEFAULT ARRAY[]::UUID[],
  ADD COLUMN "village" TEXT[] DEFAULT ARRAY[]::TEXT[];
