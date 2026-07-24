-- Backfill role_permissions for the new surveyBuilder module (see
-- rbac/role-matrix.ts for the source of truth this mirrors). Split into its
-- own migration, after the ADD VALUE migration, since a newly added enum
-- value can't safely be used in the same transaction that added it.
--
-- ngo_admin: full access (matches its "full access to every module" role).
-- ngo_research_officer: read/write/create — the role responsible for
-- creating and managing questionnaires (per the product decision).
-- Every other role: no access, initially — narrower is safer for a still-
-- evolving feature; widen deliberately later if a role needs it.
-- Guarded on the role already existing: on a from-scratch database, `roles`
-- is only populated by prisma/seed.ts, which runs after all migrations —
-- so an unconditional INSERT here fails with an FK violation on a fresh
-- `migrate reset`. Harmless to skip in that case: seed.ts's ROLE_MATRIX
-- already carries these same surveyBuilder grants for every role, so the
-- seed step fills this in right after. This only matters as a real backfill
-- on a database that was seeded before surveyBuilder existed.
INSERT INTO "role_permissions" ("id", "role_id", "module", "read", "write", "create", "approve", "export", "share")
SELECT uuidv7(), v.role_id, 'surveyBuilder', v.read, v.write, v.create, v.approve, v.export, v.share
FROM (VALUES
  ('role_ngo_admin', true, true, true, true, true, true),
  ('role_ngo_research_officer', true, true, true, false, false, false),
  ('role_field_researcher', false, false, false, false, false, false),
  ('role_human_reviewer', false, false, false, false, false, false),
  ('role_data_analyst', false, false, false, false, false, false),
  ('role_system_admin', false, false, false, false, false, false),
  ('role_read_only_viewer', false, false, false, false, false, false),
  ('role_center_supervisor', false, false, false, false, false, false),
  ('role_citizen_guest', false, false, false, false, false, false)
) AS v(role_id, "read", "write", "create", approve, export, share)
WHERE EXISTS (SELECT 1 FROM "roles" WHERE "roles"."id" = v.role_id)
ON CONFLICT ("role_id", "module") DO NOTHING;
