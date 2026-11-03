-- UAT ORG-09 — the System Admin can decline a self-registration with a reason.
-- Additive and nullable: existing organisations are unaffected.
ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "declined_at" TIMESTAMPTZ(6);
ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "declined_by" UUID;
ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "decline_reason" VARCHAR(2000);
