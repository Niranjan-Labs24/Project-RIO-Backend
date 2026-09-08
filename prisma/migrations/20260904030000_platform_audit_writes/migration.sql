-- RIO-NFR-010 (found while building it) — platform-level audit events could
-- never be written.
--
-- ─── The defect ─────────────────────────────────────────────────────────────
-- AuditService.record() routes a write with no organisation to
-- runAsSupervisor, which uses the cnap_supervisor client. That role holds
-- SELECT and nothing else, by design — it is the cross-org READ path. So the
-- INSERT failed with "permission denied for table audit_logs", the service
-- caught it, logged a warning, and returned normally.
--
-- Every audit event that belongs to no single entity has therefore been
-- silently discarded: the backup runs and retention sweeps added by this
-- ticket, and cross-entity duplicate decisions, which were changed earlier to
-- file at platform level precisely so they would stop being misattributed to
-- the reviewer's own organisation. That change turned a wrong row into no row.
--
-- ─── Why the policy has to change too ───────────────────────────────────────
-- Routing the write to the read-write client with no org GUC is only half the
-- fix. The isolation policy reads
--
--   organisation_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
--
-- With no GUC that evaluates to `organisation_id = NULL` -> NULL -> not true,
-- so a platform row fails the WITH CHECK and the INSERT is still refused.
-- IS NOT DISTINCT FROM makes NULL match NULL, which is exactly the semantics
-- already used by duplicate_candidates for its cross-entity rows.
--
-- What this does NOT widen: with a GUC set the behaviour is unchanged — an
-- entity still sees only its own rows, and platform rows stay invisible to it
-- (NULL IS NOT DISTINCT FROM <uuid> is false). The only path that gains
-- anything is the deliberate no-GUC one.
DROP POLICY IF EXISTS "audit_logs_isolation" ON "audit_logs";

CREATE POLICY "audit_logs_isolation" ON "audit_logs"
  USING (
    "organisation_id" IS NOT DISTINCT FROM
      NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    "organisation_id" IS NOT DISTINCT FROM
      NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );
