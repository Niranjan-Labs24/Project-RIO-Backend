-- RIO-RBAC-002 (client-confirmed 2026-08-23) — the runtime permission-grant
-- mechanism: Center/NCNP Supervisor holds read-only access everywhere by
-- default; this table is the only way that role ever gets a write/create/
-- approve action, one specific (module, action) pair at a time, optionally
-- scoped to a single entity and optionally time-limited. Checked by
-- PermissionGuard as a fallback only when the static role matrix already
-- says no. A grant is revoked (revoked_at/revoked_by set), never deleted or
-- edited in place, so the full grant/revoke history stays intact.
CREATE TABLE "permission_grants" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "grantee_id" UUID NOT NULL,
  "module" VARCHAR(50) NOT NULL,
  "action" VARCHAR(20) NOT NULL,
  "target_org_id" UUID,
  "reason" VARCHAR(1000) NOT NULL,
  "granted_by" UUID NOT NULL,
  "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "revoked_by" UUID,

  CONSTRAINT "permission_grants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "permission_grants_grantee_id_idx" ON "permission_grants"("grantee_id");

GRANT SELECT, INSERT, UPDATE ON "permission_grants" TO cnap_app;
GRANT SELECT ON "permission_grants" TO cnap_supervisor;
