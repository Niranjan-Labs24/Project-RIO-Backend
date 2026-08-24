-- GAP-04 security review hardening (I01 / M02 / M01). Follow-up to
-- 20260824160000_graphile_worker_grants (already applied — NOT edited here,
-- to avoid checksum drift on deployed DBs). This migration only TIGHTENS
-- privileges; it does not change what cnap_app needs to enqueue a job.
--
-- ┌─ M01 correction (accurate rationale, replacing the prior migration's ────┐
-- │ inaccurate comment) ────────────────────────────────────────────────────┤
-- │ The prior migration's comment claimed "cnap_app is not granted EXECUTE  │
-- │ on remove_job" as if that meant cnap_app could not call it. That was    │
-- │ misleading: PostgreSQL functions are EXECUTE-able by PUBLIC by default  │
-- │ unless privileges are explicitly revoked. We verified against the       │
-- │ installed graphile-worker@0.17.3 schema that                            │
-- │ remove_job/complete_jobs/permanently_fail_jobs/reschedule_jobs/         │
-- │ force_unlock_workers all had a NULL proacl (i.e. still on the default   │
-- │ ACL = PUBLIC EXECUTE), and confirmed with has_function_privilege() that │
-- │ cnap_app COULD call them despite never being explicitly granted access. │
-- │ That is queue-management surface (cancel/fail/reschedule any job, or    │
-- │ force-unlock any worker) cnap_app has no legitimate reason to hold —    │
-- │ enqueue only needs add_job/add_jobs, whose proacl already excludes      │
-- │ PUBLIC (see 20260824160000). This migration revokes PUBLIC EXECUTE on   │
-- │ the management functions so only the schema owner (cnap_owner, who runs │
-- │ the actual worker/runner) retains access. add_job/add_jobs are          │
-- │ untouched — cnap_app keeps EXECUTE on those.                            │
-- └────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ I01 (Important) — revoke PUBLIC EXECUTE on job-management functions ───┐
-- │ Verified exact installed signatures via pg_get_function_identity_       │
-- │ arguments() against the live graphile_worker schema (0.17.3):           │
-- │  • remove_job(job_key text)                                             │
-- │  • complete_jobs(job_ids bigint[])                                      │
-- │  • permanently_fail_jobs(job_ids bigint[], error_message text)          │
-- │  • reschedule_jobs(job_ids bigint[], run_at timestamptz,                │
-- │                     priority integer, attempts integer,                 │
-- │                     max_attempts integer)                               │
-- │  • force_unlock_workers(worker_ids text[])                              │
-- │ None of these are needed for enqueue (add_job/add_jobs only insert new  │
-- │ jobs). Left world-executable, any authenticated cnap_app connection     │
-- │ could cancel/complete/fail/reschedule arbitrary jobs across every       │
-- │ tenant, or force-unlock workers — a queue-integrity / DoS risk on the   │
-- │ job system (not a tenant data-isolation breach, since the private       │
-- │ tables carry no row content beyond job bookkeeping). Revoked below.     │
-- └────────────────────────────────────────────────────────────────────────┘
REVOKE EXECUTE ON FUNCTION graphile_worker.remove_job(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION graphile_worker.complete_jobs(bigint[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION graphile_worker.permanently_fail_jobs(bigint[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION graphile_worker.reschedule_jobs(bigint[], timestamptz, integer, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION graphile_worker.force_unlock_workers(text[]) FROM PUBLIC;

-- ┌─ M02 (Minor) — scope the enqueue RLS policies to the commands enqueue ──┐
-- │ actually issues, instead of FOR ALL (which silently also grants        │
-- │ DELETE). add_job -> add_jobs performs: SELECT (dedup lookups), INSERT   │
-- │ (new task/queue/job rows), and UPDATE (the INSERT ... ON CONFLICT DO    │
-- │ UPDATE upsert path plus a follow-up UPDATE on _private_jobs for         │
-- │ existing job_key rows). It never deletes rows — deletion is only done  │
-- │ by remove_job/complete_jobs, which run as the schema owner (cnap_owner, │
-- │ RLS-exempt via BYPASSRLS-equivalent ownership) and which cnap_app no    │
-- │ longer has EXECUTE on per I01 above. So cnap_app gets no DELETE policy  │
-- │ at all on these tables: dropping the FOR ALL policies and replacing     │
-- │ them with explicit per-command SELECT/INSERT/UPDATE policies closes     │
-- │ that gap while leaving enqueue fully functional.                        │
-- └────────────────────────────────────────────────────────────────────────┘
DROP POLICY cnap_app_enqueue ON graphile_worker._private_jobs;
DROP POLICY cnap_app_enqueue ON graphile_worker._private_tasks;
DROP POLICY cnap_app_enqueue ON graphile_worker._private_job_queues;

CREATE POLICY cnap_app_enqueue_select ON graphile_worker._private_jobs
  FOR SELECT TO cnap_app USING (true);
CREATE POLICY cnap_app_enqueue_insert ON graphile_worker._private_jobs
  FOR INSERT TO cnap_app WITH CHECK (true);
CREATE POLICY cnap_app_enqueue_update ON graphile_worker._private_jobs
  FOR UPDATE TO cnap_app USING (true) WITH CHECK (true);

CREATE POLICY cnap_app_enqueue_select ON graphile_worker._private_tasks
  FOR SELECT TO cnap_app USING (true);
CREATE POLICY cnap_app_enqueue_insert ON graphile_worker._private_tasks
  FOR INSERT TO cnap_app WITH CHECK (true);
CREATE POLICY cnap_app_enqueue_update ON graphile_worker._private_tasks
  FOR UPDATE TO cnap_app USING (true) WITH CHECK (true);

CREATE POLICY cnap_app_enqueue_select ON graphile_worker._private_job_queues
  FOR SELECT TO cnap_app USING (true);
CREATE POLICY cnap_app_enqueue_insert ON graphile_worker._private_job_queues
  FOR INSERT TO cnap_app WITH CHECK (true);
CREATE POLICY cnap_app_enqueue_update ON graphile_worker._private_job_queues
  FOR UPDATE TO cnap_app USING (true) WITH CHECK (true);
