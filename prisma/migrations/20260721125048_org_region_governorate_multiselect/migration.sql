/*
  Warnings:

  - You are about to drop the column `governorate_id` on the `organisations` table. All the data in the column will be lost.
  - You are about to drop the column `region_id` on the `organisations` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "organisations" DROP CONSTRAINT "organisations_governorate_id_fkey";

-- DropForeignKey
ALTER TABLE "organisations" DROP CONSTRAINT "organisations_region_id_fkey";

-- DropIndex
DROP INDEX "organisations_governorate_id_idx";

-- DropIndex
DROP INDEX "organisations_region_id_idx";

-- AlterTable
ALTER TABLE "organisations" DROP COLUMN "governorate_id",
DROP COLUMN "region_id";

-- CreateTable
CREATE TABLE "organisation_regions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "region_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisation_regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_governorates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "governorate_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisation_governorates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organisation_regions_region_id_idx" ON "organisation_regions"("region_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_regions_org_id_region_id_key" ON "organisation_regions"("org_id", "region_id");

-- CreateIndex
CREATE INDEX "organisation_governorates_governorate_id_idx" ON "organisation_governorates"("governorate_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_governorates_org_id_governorate_id_key" ON "organisation_governorates"("org_id", "governorate_id");

-- AddForeignKey
ALTER TABLE "organisation_regions" ADD CONSTRAINT "organisation_regions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_regions" ADD CONSTRAINT "organisation_regions_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_governorates" ADD CONSTRAINT "organisation_governorates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_governorates" ADD CONSTRAINT "organisation_governorates_governorate_id_fkey" FOREIGN KEY ("governorate_id") REFERENCES "governorates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Org-scoped join tables — same RLS isolation pattern as response_answers/
-- response_severity_scores/score_rollups (20260720211400_rls_severity_scoring).
ALTER TABLE "organisation_regions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organisation_regions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "organisation_governorates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organisation_governorates" FORCE ROW LEVEL SECURITY;

CREATE POLICY organisation_regions_org_isolation ON "organisation_regions"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY organisation_governorates_org_isolation ON "organisation_governorates"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "organisation_regions", "organisation_governorates" TO cnap_app;
GRANT SELECT ON "organisation_regions", "organisation_governorates" TO cnap_supervisor;

CREATE POLICY organisation_regions_supervisor_read ON "organisation_regions" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY organisation_governorates_supervisor_read ON "organisation_governorates" FOR SELECT TO cnap_supervisor USING (true);
