-- RIO-NFR-010 — provision the role that can actually take a backup.
--
-- RUN THIS AS A SUPERUSER, ONCE PER ENVIRONMENT:
--
--   psql "postgresql://postgres:<pw>@localhost:5432/cnap" -f scripts/sql/nfr010-backup-role.sql
--
-- ─── Why this is not a Prisma migration ─────────────────────────────────────
-- Migrations run as cnap_owner, and Postgres refuses: "Only roles with the
-- BYPASSRLS attribute may create roles with the BYPASSRLS attribute." That is
-- the correct behaviour, not an obstacle to work around — granting a role the
-- power to read past every row-level security policy is a database
-- administration decision, and it should require the credentials that come
-- with it. So it lives here, deliberately outside the migration chain.
--
-- ─── The defect this fixes ──────────────────────────────────────────────────
-- pg_dump has never produced a dump of this database. Run as cnap_owner —
-- which is what DATABASE_URL points at — it fails on the first table carrying
-- FORCE ROW LEVEL SECURITY:
--
--   pg_dump: error: query would be affected by row-level security policy
--            for table "ai_decisions"
--
-- 43 tables force RLS, and cnap_owner is NOBYPASSRLS like every other
-- application role, so owning a table grants no exemption. Postgres refuses
-- the COPY rather than silently writing a partial dump — the right call, and
-- the reason this was an outright failure rather than a quiet, unusable
-- backup. Nothing recorded it until backup_runs existed, so the scheduled job
-- had been failing on every tick with only a stdout line to show for it.
--
-- ─── Why a dedicated role, not BYPASSRLS on cnap_owner ──────────────────────
-- cnap_owner runs migrations and owns every table. Giving it BYPASSRLS would
-- mean the role that applies schema changes can also read every tenant's rows
-- with no policy in the way, permanently, for the convenience of a weekly job.
--
-- cnap_backup exists for one purpose. It holds SELECT and nothing else: no
-- INSERT, UPDATE or DELETE anywhere. It can copy the database out and cannot
-- change a single row in it.
--
-- BYPASSRLS is unavoidable for this role. A backup that respects row-level
-- security is a backup of almost nothing, because a dump has no org context to
-- set and every policy would evaluate against an empty GUC.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cnap_backup') THEN
    -- A DEVELOPMENT password, following cnap_supervisor's precedent in
    -- migration 20260713031212. ROTATE THIS IN ANY REAL DEPLOYMENT: the
    -- credential grants read of every tenant's data, which is precisely what a
    -- dump is. Q34 (destination, encryption, key custody) is the same
    -- conversation — this credential belongs in it.
    CREATE ROLE cnap_backup WITH LOGIN PASSWORD 'cnap_backup_dev_pw' BYPASSRLS;
  ELSE
    -- Idempotent: converge an existing role rather than fail on re-run.
    ALTER ROLE cnap_backup WITH LOGIN BYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE cnap TO cnap_backup;
GRANT USAGE ON SCHEMA public TO cnap_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cnap_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO cnap_backup;

-- Tables added by later migrations must be readable too, or the first backup
-- after a schema change silently omits the new table. Applied for both role
-- identities that create objects here.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO cnap_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO cnap_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE cnap_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO cnap_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE cnap_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO cnap_backup;

-- Then point the application at it:
--
--   BACKUP_DATABASE_URL=postgresql://cnap_backup:<pw>@localhost:5432/cnap
--
-- BackupService falls back to DATABASE_URL when this is unset, and says so in
-- the failure it records — a backup silently running as the wrong role is the
-- failure mode this whole file exists to remove.
