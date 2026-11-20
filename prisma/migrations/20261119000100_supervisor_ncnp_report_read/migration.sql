-- UAT RPT-06 — the Center Supervisor (NCNP Supervisor) gets a Kingdom-wide
-- read view that includes the NCNP collective (Needs) report: read only.
--
-- Idempotent and guarded on the role existing, like
-- 20261006000001_priority_override_grants: on a from-scratch database `roles`
-- is only populated by prisma/seed.ts, which writes this grant from ROLE_MATRIX.
INSERT INTO "role_permissions" ("id", "role_id", "module", "read", "write", "create", "approve", "export", "share")
SELECT uuidv7(), 'role_center_supervisor', 'ncnpReport', true, false, false, false, false, false
WHERE EXISTS (SELECT 1 FROM "roles" WHERE "roles"."id" = 'role_center_supervisor')
ON CONFLICT ("role_id", "module") DO UPDATE
  SET "read" = EXCLUDED."read";
