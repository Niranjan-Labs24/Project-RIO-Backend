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
INSERT INTO "role_permissions" ("id", "role_id", "module", "read", "write", "create", "approve", "export", "share")
VALUES
  -- Q23's two named owners.
  (uuidv7(), 'role_data_analyst',      'dataQuality', true, true,  false, true,  true,  false),
  (uuidv7(), 'role_system_admin',      'dataQuality', true, true,  false, true,  true,  false),

  -- Sees its own entity's data quality; cannot decide on flags. Accepting a
  -- standardization edits a Need, and the entity's account owner is not the
  -- role the client put that authority with.
  (uuidv7(), 'role_ngo_admin',         'dataQuality', true, false, false, false, true,  false),

  -- The people whose data is being flagged. They fix records by editing them
  -- (which supersedes the flag on the next run), not by deciding on flags.
  (uuidv7(), 'role_ngo_research_officer', 'dataQuality', true, false, false, false, false, false),
  (uuidv7(), 'role_field_researcher',  'dataQuality', true, false, false, false, false, false),

  -- Cross-entity oversight, read-only everywhere else on this platform too.
  (uuidv7(), 'role_center_supervisor', 'dataQuality', true, false, false, false, false, false),
  (uuidv7(), 'role_system_reviewer',   'dataQuality', true, false, false, false, false, false),
  (uuidv7(), 'role_read_only_viewer',  'dataQuality', true, false, false, false, false, false)
ON CONFLICT ("role_id", "module") DO NOTHING;
