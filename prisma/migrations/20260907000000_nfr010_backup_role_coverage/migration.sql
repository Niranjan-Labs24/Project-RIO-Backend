-- RIO-NFR-010 — re-cover every RLS table for cnap_backup.
--
-- ─── What went wrong ────────────────────────────────────────────────────────
-- 20260904040000 generated one read policy per RLS-enabled table, and said in
-- its own comment that a table added by a LATER migration would not be covered.
-- Four now are not, and a manual backup found them exactly as designed:
--
--   4 table(s) enforce row-level security with no cnap_backup read policy, so
--   a dump would silently omit their rows: historical_studies, initiatives,
--   need_analytical_status_events, need_initiatives.
--
-- Two different causes, one fix:
--   * historical_studies is from 20260904060000 — genuinely later, so it was
--     never covered on any database.
--   * initiatives, need_initiatives and need_analytical_status_events are from
--     20260902065050, which is EARLIER by name but was applied on this
--     database a day AFTER the backup-role migration (branches merging). A
--     fresh database would have covered them; an existing one did not. Nothing
--     about migration order is a guarantee here, which is the point.
--
-- ─── Why this refuses instead of hoping ─────────────────────────────────────
-- The generator is idempotent, so re-running it converges on whatever the
-- schema now contains. What is new is the assertion at the end: if any RLS
-- table is still uncovered when this finishes, the migration RAISES. A
-- coverage migration that silently under-covers is the same failure it exists
-- to fix, one layer down.
--
-- This does NOT stop it happening again — the next migration to add an RLS
-- table starts the clock over. What catches that is BackupService's
-- assertBackupRoleCoverage(), which refuses the dump and names the tables
-- rather than letting --enable-row-security emit them as empty. Re-run this
-- migration's DO block whenever it does.

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

-- Tables created since 20260904040000 also need the plain SELECT grant: the
-- ALTER DEFAULT PRIVILEGES there only applies to tables created AFTER it ran,
-- and only for the role that created them. A policy without a grant reads as
-- "permission denied for table", which is a different error and just as fatal
-- to a dump.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cnap_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO cnap_backup;

-- The assertion. Same catalogue query BackupService runs before every dump —
-- if it would refuse to back up after this migration, the migration itself
-- fails here instead.
DO $$
DECLARE
  uncovered TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO uncovered
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relrowsecurity
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies pp
        WHERE pp.schemaname = 'public'
          AND pp.tablename = c.relname
          AND 'cnap_backup' = ANY (pp.roles)
     );

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION 'cnap_backup still has no read policy on: %', uncovered;
  END IF;
END $$;
