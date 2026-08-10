-- RIO-FR-010: self-registered entities require Center (System Admin)
-- approval before activation. Null approvedAt = never approved yet.
ALTER TABLE "organisations" ADD COLUMN "approved_at" TIMESTAMPTZ(6);
ALTER TABLE "organisations" ADD COLUMN "approved_by" UUID;

-- Every organisation that already exists today was created before this gate
-- existed (either self-registered under the old no-gate flow, or created
-- directly by System Admin) — backfill as already-approved so no existing
-- entity is retroactively locked out.
UPDATE "organisations" SET "approved_at" = "created_at" WHERE "approved_at" IS NULL;
