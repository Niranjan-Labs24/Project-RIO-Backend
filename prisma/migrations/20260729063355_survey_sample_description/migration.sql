-- Additive, all-nullable — no backfill. A new Survey Design step (Sample
-- Description: Target Group, Expected Sample Size, Selection Approach,
-- Geographic Coverage), mandatory together before Submit for Approval going
-- forward (see SurveysService.submitForApproval), but nullable here since
-- existing surveys predate this step and were never asked for it.

-- AlterTable
ALTER TABLE "surveys" ADD COLUMN     "expected_sample_size" INTEGER,
ADD COLUMN     "geographic_coverage" VARCHAR(500),
ADD COLUMN     "selection_approach" VARCHAR(1000),
ADD COLUMN     "target_group" VARCHAR(500);
