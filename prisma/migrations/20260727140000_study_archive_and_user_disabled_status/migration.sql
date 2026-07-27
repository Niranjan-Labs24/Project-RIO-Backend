-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'disabled';

-- AlterTable
ALTER TABLE "studies" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS "archived_by" TEXT,
ADD COLUMN IF NOT EXISTS "archive_reason" TEXT;
