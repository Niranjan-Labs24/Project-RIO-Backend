-- Public NGO signup: organisations now carry purpose + a unique
-- registration number (the field used to block a duplicate signup for the
-- same NGO), and users carry the fields needed for real password-based
-- auth. See prisma/schema.prisma for field-level rationale.

-- AlterTable
ALTER TABLE "organisations"
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "registration_number" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';

-- Drop the temporary defaults now that existing rows (if any) are backfilled
-- with a placeholder — new rows always supply real values via the signup API.
ALTER TABLE "organisations" ALTER COLUMN "purpose" DROP DEFAULT;
ALTER TABLE "organisations" ALTER COLUMN "registration_number" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "organisations_registration_number_key" ON "organisations"("registration_number");

-- AlterTable
ALTER TABLE "users"
  ADD COLUMN "name" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "password_hash" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "role" TEXT NOT NULL DEFAULT 'ngo_admin';

ALTER TABLE "users" ALTER COLUMN "name" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
