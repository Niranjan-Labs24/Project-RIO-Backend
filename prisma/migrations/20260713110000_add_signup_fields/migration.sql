-- Additive signup fields. All nullable/defaulted so existing rows are unaffected.
ALTER TABLE "organisations" ADD COLUMN "purpose" VARCHAR(500);
ALTER TABLE "organisations" ADD COLUMN "registration_number" VARCHAR(100);
CREATE UNIQUE INDEX "organisations_registration_number_key"
  ON "organisations" ("registration_number");

ALTER TABLE "users"
  ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;
