-- UAT NED-01 — deleting a draft / unclassified need is a soft delete: the
-- row (and its evidence) is kept for the audit trail and hidden everywhere
-- through the same filter that hides merged needs (EXCLUDE_MERGED).
ALTER TABLE "needs" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "needs" ADD COLUMN IF NOT EXISTS "deleted_by" UUID;
