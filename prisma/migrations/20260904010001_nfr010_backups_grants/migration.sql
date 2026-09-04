-- RIO-NFR-010 — who may see and run backups.
--
-- Separate migration from 20260904010000 because Postgres refuses to use a new
-- enum value in the transaction that added it.
--
--   read   = see the run history, the summary, and verify a stored artefact.
--            Verifying is a read: it re-checksums a file and changes nothing.
--   write  = trigger a backup now, and run the retention sweep. Both consume
--            resources on a live system and the sweep deletes files, so this
--            is deliberately narrower than read.
--
-- System Admin only, for now. A backup dump contains every entity's rows, so
-- no entity-scoped role can be given sight of it — this is the same reasoning
-- that keeps the backup_runs table free of org_id and RLS.
--
-- System Reviewer gets READ but not write: the platform-wide oversight role
-- should be able to answer "is this platform being backed up" without being
-- able to start or delete anything.
--
-- Idempotent: ON CONFLICT so re-running, or a later `prisma:seed` writing the
-- same rows from ROLE_MATRIX, is a no-op rather than a failure.
INSERT INTO "role_permissions" ("id", "role_id", "module", "read", "write", "create", "approve", "export", "share")
VALUES
  (uuidv7(), 'role_system_admin',    'backups', true, true,  false, false, true,  false),
  (uuidv7(), 'role_system_reviewer', 'backups', true, false, false, false, false, false)
ON CONFLICT ("role_id", "module") DO UPDATE
  SET "read"   = EXCLUDED."read",
      "write"  = EXCLUDED."write",
      "export" = EXCLUDED."export";
