-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_org_id_idx" ON "password_reset_tokens"("org_id");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (RIO-NFR-003 pattern) — same fail-closed NULLIF policy as
-- every other org_id-keyed table (see 20260716093000_dev1_week2_week3_schema).
ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY password_reset_tokens_org_isolation ON "password_reset_tokens"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Runtime grants for cnap_app (NOBYPASSRLS). No DELETE — consumed/expired
-- tokens are just left in place, same retention posture as citizen_otp_challenges.
GRANT SELECT, INSERT, UPDATE ON "password_reset_tokens" TO cnap_app;

-- Cross-org read policy for cnap_supervisor: the forgot-password/reset-password
-- flow runs before any org context exists yet (the requester is identified only
-- by email/token, not by org) — same mechanism the citizen routes use to resolve
-- an org-less lookup (see TenantPrismaService.runAsSupervisor).
CREATE POLICY password_reset_tokens_supervisor_read ON "password_reset_tokens" FOR SELECT TO cnap_supervisor USING (true);
GRANT SELECT ON "password_reset_tokens" TO cnap_supervisor;
