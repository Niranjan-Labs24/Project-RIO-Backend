-- RIO-FR-002 — who may see and act on the Data Quality reviewer queue.
--
-- Separate migration from 20260902030000 because Postgres refuses to use a new
-- enum value in the transaction that added it.
--
-- The split of authority follows Q23, which puts tuning and decisions with
-- System Admin / Data Analyst — "the same role that already receives
-- low-confidence and override flags for investigation":
--
--   approve  = accept or reject a flag. A standardization the reviewer accepts
--              is WRITTEN to the record, so this is a real edit right.
--   write    = adjust the rule set's thresholds (Q23's tuning ownership).
--   read     = see the queue and the per-source report, act on nothing.
--
-- Everyone else with a legitimate interest gets read. Entity roles see their
-- own org's flags through RLS; Center/NCNP Supervisor and System Reviewer see
-- across entities through the existing cnap_supervisor read path.
--
-- Idempotent: ON CONFLICT so re-running, or a later `prisma:seed` writing the
-- same rows from ROLE_MATRIX, is a no-op rather than a failure.
--
-- Guarded on the role already existing, the same way
-- 20260717120001_survey_builder_role_grants is. On a from-scratch database
-- `roles` is only populated by prisma/seed.ts, which runs AFTER
-- `prisma migrate deploy` — so an unconditional INSERT here dies with
-- "role_permissions_role_id_fkey ... Key (role_id)=(role_data_analyst) is not
-- present in table roles". Harmless to skip in that case: ROLE_MATRIX already
-- carries these same dataQuality grants, so the seed step writes them moments
-- later. This only matters as a real backfill on a database seeded before
-- dataQuality existed.
INSERT INTO "role_permissions" ("id", "role_id", "module", "read", "write", "create", "approve", "export", "share")
SELECT uuidv7(), v.role_id, 'dataQuality', v."read", v."write", v."create", v.approve, v.export, v.share
FROM (VALUES
  -- Q23's two named owners.
  ('role_data_analyst', true, true,  false, true,  true,  false),
  ('role_system_admin', true, true,  false, true,  true,  false),

  -- Sees its own entity's data quality; cannot decide on flags. Accepting a
  -- standardization edits a Need, and the entity's account owner is not the
  -- role the client put that authority with.
  ('role_ngo_admin', true, false, false, false, true,  false),

  -- The people whose data is being flagged. They fix records by editing them
  -- (which supersedes the flag on the next run), not by deciding on flags.
  ('role_ngo_research_officer', true, false, false, false, false, false),
  ('role_field_researcher', true, false, false, false, false, false),

  -- Cross-entity oversight, read-only everywhere else on this platform too.
  ('role_center_supervisor', true, false, false, false, false, false),
  ('role_system_reviewer', true, false, false, false, false, false),
  ('role_read_only_viewer', true, false, false, false, false, false)
) AS v(role_id, "read", "write", "create", approve, export, share)
WHERE EXISTS (SELECT 1 FROM "roles" WHERE "roles"."id" = v.role_id)
ON CONFLICT ("role_id", "module") DO NOTHING;
