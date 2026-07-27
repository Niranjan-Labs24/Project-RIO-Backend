-- Restore the Study lifecycle column removed by
-- 20260717191000_need_multi_scope_tighten. Prisma selects every scalar
-- column by default, so this must exist before seed or runtime Study reads.
ALTER TABLE "studies"
ADD COLUMN IF NOT EXISTS "status" VARCHAR(50) NOT NULL DEFAULT 'active';

-- Align the original archive migration with the Prisma native types.
ALTER TABLE "studies"
ALTER COLUMN "archived_by" TYPE UUID
USING "archived_by"::UUID,
ALTER COLUMN "archive_reason" TYPE VARCHAR(500);
