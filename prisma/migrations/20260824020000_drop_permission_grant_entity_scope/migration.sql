-- RIO-RBAC-002 (client-confirmed 2026-08-23, reconfirmed 2026-08-24): "a
-- grant applies across all entities once given — it is not scoped to a
-- single entity." The built Permission Grants screen contradicted this by
-- letting a System Admin optionally scope a grant to one org. Dropping the
-- column entirely rather than just stopping use of it at the application
-- layer — there is no valid state in which a single-entity scope should
-- exist going forward.
ALTER TABLE "permission_grants" DROP COLUMN "target_org_id";
