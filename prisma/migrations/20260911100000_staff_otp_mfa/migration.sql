-- RIO MFA — "Sign in with OTP" for staff accounts (all roles), on top of
-- the existing citizen-only OTP flow.

-- AlterTable: capture an optional mobile number at signup (NGO Admin) or
-- invite time (any role). Nullable — an account without one simply can't
-- use SMS OTP sign-in.
ALTER TABLE "users" ADD COLUMN "mobile_number" VARCHAR(32);

-- CreateTable
CREATE TABLE "staff_otp_challenges" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" VARCHAR(16) NOT NULL,
    "code_hash" VARCHAR(255) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_otp_challenges_org_id_idx" ON "staff_otp_challenges"("org_id");

-- CreateIndex
CREATE INDEX "staff_otp_challenges_user_id_idx" ON "staff_otp_challenges"("user_id");

-- AddForeignKey
ALTER TABLE "staff_otp_challenges" ADD CONSTRAINT "staff_otp_challenges_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_otp_challenges" ADD CONSTRAINT "staff_otp_challenges_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (RIO-NFR-003 pattern) — same fail-closed NULLIF policy as
-- every other org_id-keyed table (see 20260716093000_dev1_week2_week3_schema).
ALTER TABLE "staff_otp_challenges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_otp_challenges" FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_otp_challenges_org_isolation ON "staff_otp_challenges"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Runtime grants for cnap_app (NOBYPASSRLS). No DELETE — consumed/expired
-- challenges are just left in place, same retention posture as
-- password_reset_tokens/citizen_otp_challenges.
GRANT SELECT, INSERT, UPDATE ON "staff_otp_challenges" TO cnap_app;

-- Cross-org read policy for cnap_supervisor: requesting a login OTP runs
-- before any org context exists yet (the requester is identified only by
-- email or mobile number, not by org) — same mechanism the
-- forgot-password/reset-password flow uses (see
-- TenantPrismaService.runAsSupervisor and password_reset_tokens_supervisor_read).
CREATE POLICY staff_otp_challenges_supervisor_read ON "staff_otp_challenges" FOR SELECT TO cnap_supervisor USING (true);
GRANT SELECT ON "staff_otp_challenges" TO cnap_supervisor;
