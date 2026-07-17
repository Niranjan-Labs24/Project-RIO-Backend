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
INSERT INTO "role_permissions" ("id", "role_id", "module", "read", "write", "create", "approve", "export", "share")
VALUES
  (uuidv7(), 'role_ngo_admin', 'surveyBuilder', true, true, true, true, true, true),
  (uuidv7(), 'role_ngo_research_officer', 'surveyBuilder', true, true, true, false, false, false),
  (uuidv7(), 'role_field_researcher', 'surveyBuilder', false, false, false, false, false, false),
  (uuidv7(), 'role_human_reviewer', 'surveyBuilder', false, false, false, false, false, false),
  (uuidv7(), 'role_data_analyst', 'surveyBuilder', false, false, false, false, false, false),
  (uuidv7(), 'role_system_admin', 'surveyBuilder', false, false, false, false, false, false),
  (uuidv7(), 'role_read_only_viewer', 'surveyBuilder', false, false, false, false, false, false),
  (uuidv7(), 'role_center_supervisor', 'surveyBuilder', false, false, false, false, false, false),
  (uuidv7(), 'role_citizen_guest', 'surveyBuilder', false, false, false, false, false, false)
ON CONFLICT ("role_id", "module") DO NOTHING;
