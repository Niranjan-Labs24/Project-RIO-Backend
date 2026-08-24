-- GAP-02 — tamper-evident audit via periodic signed checkpoints.
--
-- audit_checkpoints: a chained, HMAC-signed digest over audit_logs rows,
-- computed periodically by AuditCheckpointService and verifiable on demand
-- (GET /audit/integrity). Append-only is already enforced for the app on
-- audit_logs itself (cnap_app has SELECT, INSERT only — no UPDATE/DELETE);
-- this table's checkpoints let a verifier detect if that history was later
-- edited by a privileged actor (DB owner/superuser) bypassing the app.
--
-- No RLS org-isolation policy here, on purpose: a checkpoint spans every
-- org's audit rows in one global chain — it is not org-owned data. Grants
-- do the confinement instead, same "global table, no RLS" pattern as
-- system_logs / ncnp_report_reviews: cnap_app may SELECT and INSERT (the
-- checkpoint job runs under runAsSupervisorWrite, the read-write app role
-- with no org GUC), cnap_supervisor may SELECT (the verify path and the
-- job's own "read the latest checkpoint" step run under runAsSupervisor).
-- No UPDATE/DELETE grant to anyone at runtime — append-only, same posture
-- as audit_logs; a checkpoint that could be altered or deleted would defeat
-- its own purpose.

-- CreateTable
CREATE TABLE "audit_checkpoints" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "prev_chain_hash" CHAR(64),
    "covered_from_id" UUID,
    "covered_to_id" UUID NOT NULL,
    "covered_to_created_at" TIMESTAMPTZ(6) NOT NULL,
    "row_count" INTEGER NOT NULL,
    "digest" CHAR(64) NOT NULL,
    "signature" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_checkpoints_created_at_idx" ON "audit_checkpoints"("created_at");

-- Runtime grants. No RLS: see the table comment above.
GRANT SELECT, INSERT ON "audit_checkpoints" TO cnap_app;
GRANT SELECT ON "audit_checkpoints" TO cnap_supervisor;
