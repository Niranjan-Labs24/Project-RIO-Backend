-- AlterTable
ALTER TABLE "needs" ADD COLUMN     "proposed_domains" JSONB,
ADD COLUMN     "proposed_reason" TEXT;
