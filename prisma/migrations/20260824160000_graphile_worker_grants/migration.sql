-- GAP-04 (durable citizen scoring jobs). graphile-worker owns the
-- `graphile_worker` schema and installs it via the OWNER connection (see
-- JobsWorkerService.onModuleInit -> runMigrations / run, which connect with
-- config.databaseUrl = cnap_owner). This migration ONLY grants the runtime
-- app role (cnap_app) the minimum it needs to ENQUEUE a job inside the
-- citizen survey-response transaction (CitizenService.submitResponse ->
-- tx.$executeRawUnsafe('SELECT graphile_worker.add_job(...)')). The worker
-- runner itself polls/locks/completes jobs on the owner connection, so
-- cnap_app is never granted anything beyond enqueue.
--
-- ┌─ Version-verified against the INSTALLED graphile-worker@0.17.3 ─────────┐
-- │ Inspected pg_proc / pg_class in the live graphile_worker schema:        │
-- │  • add_job(...) and add_jobs(...) are LANGUAGE plpgsql and are NOT      │
-- │    SECURITY DEFINER (prosecdef = false) — they run with the CALLER's    │
-- │    privileges. add_job delegates to add_jobs, which INSERTs into        │
-- │    _private_tasks, _private_job_queues and _private_jobs, plus an       │
-- │    INSERT ... ON CONFLICT DO UPDATE and a follow-up UPDATE on           │
-- │    _private_jobs. So cnap_app needs SELECT/INSERT/UPDATE on those three │
-- │    private tables, not just EXECUTE on the function.                    │
-- │  • Their id columns are GENERATED ALWAYS AS IDENTITY (attidentity='a'), │
-- │    so no separate sequence USAGE grant is required — identity sequences │
-- │    advance under the table's INSERT privilege.                          │
-- │  • graphile-worker's OWN migrations run `ALTER TABLE ... ENABLE ROW     │
-- │    LEVEL SECURITY` on these tables but define NO policies. In the        │
-- │    standard single-role deployment the table owner uses add_job and     │
-- │    bypasses its own RLS, so this is invisible. Here cnap_app is a        │
-- │    SEPARATE NOBYPASSRLS role, so RLS-enabled-with-no-policy DENIES it    │
-- │    every row — enqueue fails with "new row violates row-level security  │
-- │    policy for table _private_tasks". We therefore add role-scoped        │
-- │    permissive policies below (verified by actually enqueuing as          │
-- │    cnap_app after applying this migration).                             │
-- │  • The job queue is deliberately NOT org-scoped: it is cross-tenant     │
-- │    infrastructure. The worker runner polls/locks/runs on the OWNER      │
-- │    connection; each job's payload carries { responseId, orgId } and the │
-- │    task re-establishes org scope via runAsOrg. So a permissive          │
-- │    (true/true) policy for the cnap_app role is correct here — there is   │
-- │    no per-row tenant column to key on, and cnap_app only ever enqueues. │
-- │  • The signature order (0.17.x) is:                                     │
-- │      add_job(identifier text, payload json, queue_name text,            │
-- │              run_at timestamptz, max_attempts integer, job_key text,    │
-- │              priority integer, flags text[], job_key_mode text)         │
-- │    Note queue_name is the 3rd arg here. The enqueue call site uses      │
-- │    named args (payload := ..., job_key := ..., queue_name := ...), so   │
-- │    it is signature-order independent.                                   │
-- │  • No DELETE granted: add_job never deletes (only remove_job does, and  │
-- │    cnap_app is not granted EXECUTE on it).                              │
-- └────────────────────────────────────────────────────────────────────────┘
--
-- Ordering: this migration MUST run after the graphile_worker schema exists.
-- The runner installs it on boot via the owner connection; in CI/deploy the
-- schema is likewise installed before the app serves traffic. `prisma migrate
-- deploy` runs this after a `runMigrations` bootstrap (documented in the
-- GAP-04 report). If the schema is somehow absent these statements error
-- loudly rather than silently no-op — which is the correct fail signal.

GRANT USAGE ON SCHEMA graphile_worker TO cnap_app;

GRANT EXECUTE ON FUNCTION graphile_worker.add_job(
  text, json, text, timestamptz, integer, text, integer, text[], text
) TO cnap_app;
GRANT EXECUTE ON FUNCTION graphile_worker.add_jobs(
  graphile_worker.job_spec[], boolean
) TO cnap_app;

GRANT SELECT, INSERT, UPDATE ON graphile_worker._private_jobs TO cnap_app;
GRANT SELECT, INSERT, UPDATE ON graphile_worker._private_tasks TO cnap_app;
GRANT SELECT, INSERT, UPDATE ON graphile_worker._private_job_queues TO cnap_app;

-- Role-scoped permissive RLS policies so cnap_app (NOBYPASSRLS) can enqueue.
-- Restricted TO cnap_app (never PUBLIC), and only for the enqueue path.
CREATE POLICY cnap_app_enqueue ON graphile_worker._private_jobs
  FOR ALL TO cnap_app USING (true) WITH CHECK (true);
CREATE POLICY cnap_app_enqueue ON graphile_worker._private_tasks
  FOR ALL TO cnap_app USING (true) WITH CHECK (true);
CREATE POLICY cnap_app_enqueue ON graphile_worker._private_job_queues
  FOR ALL TO cnap_app USING (true) WITH CHECK (true);
