-- RIO-NFR-010 — re-cover every RLS table for cnap_backup, again.
--
-- ─── Why a second one ───────────────────────────────────────────────────────
-- 20260907000000_nfr010_backup_role_coverage says this in its own comment:
--
--   This does NOT stop it happening again — the next migration to add an RLS
--   table starts the clock over. [...] Re-run this migration's DO block
--   whenever it does.
--
-- It has happened again. A manual backup on the sprint3 branch refused with:
--
--   2 table(s) enforce row-level security with no cnap_backup read policy, so
--   a dump would silently omit their rows: needs, evidence.
--
-- `needs` and `evidence` are old tables, not new ones — so this is the second
-- of that migration's two causes rather than the first: a later migration
-- re-created or replaced their policies on an existing database, and the
-- earlier coverage pass had already run. A fresh database is fine; this one
-- is not, which is exactly the case the assertion exists to catch.
--
-- Deliberately a re-run of the same generator rather than two hand-written
-- CREATE POLICY statements for those two tables. Naming them would fix today's
-- symptom and leave the next occurrence to be discovered by another failed
-- backup; the generator converges on whatever the schema currently holds.
--
-- Same assertion at the end: if any RLS table is still uncovered when this
-- finishes, the migration RAISES rather than reporting success over a backup
-- that would silently omit rows.

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

-- A policy without a grant reads as "permission denied for table", which is a
-- different error and just as fatal to a dump.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cnap_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO cnap_backup;

-- Same catalogue query BackupService runs before every dump — if it would
-- refuse to back up after this migration, the migration itself fails here.
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
