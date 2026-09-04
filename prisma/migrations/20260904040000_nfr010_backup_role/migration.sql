-- RIO-NFR-010 — a role that can actually take a backup, without a superuser.
--
-- ─── The defect ─────────────────────────────────────────────────────────────
-- pg_dump has never produced a dump of this database. Run as cnap_owner, which
-- is what DATABASE_URL points at, it fails on the first of 43 tables that FORCE
-- row-level security:
--
--   pg_dump: error: query would be affected by row-level security policy
--            for table "ai_decisions"
--
-- Every application role is NOBYPASSRLS and owning a table grants no exemption,
-- so Postgres refuses the COPY rather than writing a partial dump. That is the
-- right behaviour; the problem was that nothing recorded the failure until
-- backup_runs existed, so a scheduled job failed on every tick with only a
-- stdout line to show for it.
--
-- ─── Why this is a migration and not a superuser script ─────────────────────
-- The obvious fix is BYPASSRLS, and it cannot be done here: Postgres refuses
-- with "Only roles with the BYPASSRLS attribute may create roles with the
-- BYPASSRLS attribute", and migrations run as cnap_owner.
--
-- But BYPASSRLS is not the only way to read every row. cnap_owner DOES hold
-- CREATEROLE, and it owns every table, so it can grant a role explicit
-- read policies — which is exactly how cnap_supervisor already reads across
-- entities on 46 tables. Same mechanism, applied to all of them.
--
-- This is better than BYPASSRLS on two counts:
--   * least privilege — the role can read, and holds no INSERT, UPDATE or
--     DELETE anywhere. It can copy the database out and cannot change a row.
--   * visibility — a blanket attribute is invisible in pg_policies, while a
--     policy per table is enumerable, greppable and reviewable.
--
-- ─── The cost, stated plainly ───────────────────────────────────────────────
-- A table added by a later migration with RLS enabled and NO backup policy will
-- make pg_dump fail on that table. That is loud, not silent: the run is
-- recorded as failed in backup_runs with the table named, and NFR-016 gets an
-- error-level SystemLog. `pnpm nfr010:verify-backup-role` asserts the coverage
-- so it is caught before a backup does.
--
-- Password: a development value, following cnap_supervisor's precedent in
-- 20260713031212. ROTATE IT in any real deployment — the credential grants read
-- of every tenant's data, which is precisely what a dump is. Q34 (destination,
-- encryption, key custody) is the same conversation and this belongs in it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cnap_backup') THEN
    CREATE ROLE cnap_backup WITH LOGIN PASSWORD 'cnap_backup_dev_pw' NOBYPASSRLS;
  ELSE
    ALTER ROLE cnap_backup WITH LOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE cnap TO cnap_backup;
GRANT USAGE ON SCHEMA public TO cnap_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cnap_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO cnap_backup;

-- Tables created by later migrations are readable without another grant. This
-- does NOT cover their RLS policy — see the note above.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO cnap_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO cnap_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE cnap_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO cnap_backup;

-- One read policy per RLS-enabled table. Generated rather than listed: 43
-- hand-written policies would be wrong the first time a table was added, and
-- this converges on whatever the schema actually contains.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relrowsecurity
     ORDER BY c.relname
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', rec.table_name || '_backup_read', rec.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO cnap_backup USING (true)',
      rec.table_name || '_backup_read',
      rec.table_name
    );
  END LOOP;
END $$;
