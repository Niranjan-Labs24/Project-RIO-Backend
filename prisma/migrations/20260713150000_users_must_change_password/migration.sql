-- Every signup-issued account gets a temp password (never user-chosen), so
-- it must force a change on first login. Seeded demo accounts (see
-- prisma/seed.ts) already "know" their password and are set to `false`
-- there.
ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT true;

-- POST /auth/change-password updates password_hash + must_change_password
-- for the signed-in user, scoped by the existing users_org_isolation policy
-- (org_id = app.current_org_id) — same isolation guarantee as any other
-- write, no new policy needed.
GRANT UPDATE ON "users" TO cnap_app;
