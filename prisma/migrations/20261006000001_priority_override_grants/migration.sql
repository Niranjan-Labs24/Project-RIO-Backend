-- RIO-FR-003 AC 5 — who may override a priority score by hand.
--
-- Separate migration from 20261006000000 because Postgres refuses to use a new
-- enum value in the transaction that added it.
--
-- Human Reviewer only. It already held priorityScoring `approve`, which is
-- what gated the override before, so its abilities do not change. The Data
-- Analyst also held that flag and is deliberately left out: it keeps
-- priorityScoring `approve` for approving scores and confirming summaries,
-- but can no longer enter a score itself.
--
-- Idempotent and guarded on the role existing, the same way
-- 20260904010001_nfr010_backups_grants is: on a from-scratch database `roles`
-- is only populated by prisma/seed.ts after `migrate deploy`, and the seed
-- writes this same grant from ROLE_MATRIX.
INSERT INTO "role_permissions" ("id", "role_id", "module", "read", "write", "create", "approve", "export", "share")
SELECT uuidv7(), v.role_id, 'priorityOverride', v."read", v."write", v."create", v.approve, v.export, v.share
FROM (VALUES
  ('role_human_reviewer', true, false, false, true, false, false)
) AS v(role_id, "read", "write", "create", approve, export, share)
WHERE EXISTS (SELECT 1 FROM "roles" WHERE "roles"."id" = v.role_id)
ON CONFLICT ("role_id", "module") DO UPDATE
  SET "read"    = EXCLUDED."read",
      "approve" = EXCLUDED."approve";
