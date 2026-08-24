-- GAP-13 — durable retry queue for evidence files whose physical delete
-- (EvidenceStorageService.remove -> fs unlink) failed after the DB row was
-- already removed in EvidenceService.remove. That failure used to be
-- swallowed (.catch(() => undefined)), silently orphaning the file on disk.
-- A row here means "the DB record is gone but the file might still be on
-- disk" — EvidenceFileCleanupService's cron sweep retries the unlink and
-- deletes the row on success, or increments attempts/records lastError and
-- leaves the row for the next sweep on failure.
--
-- No RLS org-isolation policy here, on purpose: by the time a row is
-- written the owning Evidence/org context is already gone (the DB delete
-- already committed), and the sweep itself is a cross-org cron job with no
-- org GUC set. Grants do the confinement instead. Same "global table, no
-- RLS" pattern as system_logs/ncnp_report_reviews — unlike system_logs
-- (append-only-ish audit trail: INSERT/DELETE plus a narrow column SELECT),
-- this table is actively read, updated (attempts/lastError) and deleted by
-- the same cnap_app connection the sweep runs under (runAsSupervisorWrite),
-- so it gets full SELECT, INSERT, UPDATE, DELETE rather than the narrower
-- system_logs grant shape.
--
-- Note: Prisma's auto-generated diff for this migration also proposed
-- `DROP INDEX "system_logs_message_trgm_idx"` because that index isn't
-- representable in schema.prisma (it's a hand-added GIN/trigram index — see
-- 20260808090000_add_system_logs). That line has been removed from this
-- migration; it does not belong here and must never drop that index.

-- CreateTable
CREATE TABLE "pending_file_deletions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "storage_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_file_deletions_pkey" PRIMARY KEY ("id")
);

-- Runtime grants.
--
-- cnap_app: full SELECT, INSERT, UPDATE, DELETE. The main request path
-- inserts a row when a physical delete fails; the cron sweep
-- (EvidenceFileCleanupService, via runAsSupervisorWrite — no org GUC, safe
-- because this table has no RLS policy to bypass) reads pending rows,
-- deletes them on a successful retry, and updates attempts/last_error on a
-- failed retry.
GRANT SELECT, INSERT, UPDATE, DELETE ON "pending_file_deletions" TO cnap_app;
