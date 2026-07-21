-- AlterTable
ALTER TABLE "response_quality_results" ALTER COLUMN "missing_fields" DROP DEFAULT;

-- AlterTable
ALTER TABLE "surveys" ADD COLUMN     "approved_at" TIMESTAMPTZ(6),
ADD COLUMN     "approved_by" UUID,
ADD COLUMN     "approver_comments" TEXT,
ADD COLUMN     "published_at" TIMESTAMPTZ(6),
ADD COLUMN     "published_by" UUID,
ADD COLUMN     "rejected_at" TIMESTAMPTZ(6),
ADD COLUMN     "rejected_by" UUID,
ADD COLUMN     "submitted_at" TIMESTAMPTZ(6);
