/*
  Warnings:

  - You are about to drop the column `center_id` on the `organisations` table. All the data in the column will be lost.
  - You are about to drop the `organisation_regions` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "organisation_regions" DROP CONSTRAINT "organisation_regions_org_id_fkey";

-- DropForeignKey
ALTER TABLE "organisation_regions" DROP CONSTRAINT "organisation_regions_region_id_fkey";

-- DropForeignKey
ALTER TABLE "organisations" DROP CONSTRAINT "organisations_center_id_fkey";

-- DropIndex
DROP INDEX "organisations_center_id_idx";

-- AlterTable
ALTER TABLE "needs" ADD COLUMN     "governorate_id" UUID;

-- AlterTable
ALTER TABLE "organisations" DROP COLUMN "center_id",
ADD COLUMN     "region_id" UUID;

-- AlterTable
ALTER TABLE "sharing_requests" ADD COLUMN     "decision_note" VARCHAR(1000);

-- AlterTable
ALTER TABLE "studies" ADD COLUMN     "governorate_id" UUID;

-- DropTable
DROP TABLE "organisation_regions";

-- CreateTable
CREATE TABLE "need_centers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "need_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "center_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "need_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_centers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "center_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisation_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_sharing_requests" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "owner_org_id" UUID NOT NULL,
    "requesting_org_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "status" "SharingStatus" NOT NULL DEFAULT 'pending',
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "note" VARCHAR(1000),
    "decision_note" VARCHAR(1000),

    CONSTRAINT "report_sharing_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "need_centers_center_id_idx" ON "need_centers"("center_id");

-- CreateIndex
CREATE INDEX "need_centers_org_id_idx" ON "need_centers"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "need_centers_need_id_center_id_key" ON "need_centers"("need_id", "center_id");

-- CreateIndex
CREATE INDEX "organisation_centers_center_id_idx" ON "organisation_centers"("center_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_centers_org_id_center_id_key" ON "organisation_centers"("org_id", "center_id");

-- CreateIndex
CREATE INDEX "report_sharing_requests_owner_org_id_idx" ON "report_sharing_requests"("owner_org_id");

-- CreateIndex
CREATE INDEX "report_sharing_requests_requesting_org_id_idx" ON "report_sharing_requests"("requesting_org_id");

-- CreateIndex
CREATE INDEX "report_sharing_requests_report_id_idx" ON "report_sharing_requests"("report_id");

-- CreateIndex
CREATE INDEX "organisations_region_id_idx" ON "organisations"("region_id");

-- AddForeignKey
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studies" ADD CONSTRAINT "studies_governorate_id_fkey" FOREIGN KEY ("governorate_id") REFERENCES "governorates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "needs" ADD CONSTRAINT "needs_governorate_id_fkey" FOREIGN KEY ("governorate_id") REFERENCES "governorates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "need_centers" ADD CONSTRAINT "need_centers_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "need_centers" ADD CONSTRAINT "need_centers_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_centers" ADD CONSTRAINT "organisation_centers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_centers" ADD CONSTRAINT "organisation_centers_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_sharing_requests" ADD CONSTRAINT "report_sharing_requests_owner_org_id_fkey" FOREIGN KEY ("owner_org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_sharing_requests" ADD CONSTRAINT "report_sharing_requests_requesting_org_id_fkey" FOREIGN KEY ("requesting_org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_sharing_requests" ADD CONSTRAINT "report_sharing_requests_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Org-scoped join tables — same RLS isolation pattern as
-- organisation_governorates (20260721125048_org_region_governorate_multiselect).
-- report_sharing_requests deliberately has NO RLS, mirroring sharing_requests
-- (see that model's own comment in schema.prisma) — a request is inherently
-- visible to both the owning and requesting orgs plus the cross-entity
-- Center Supervisor, so authorization is enforced in service code instead.
ALTER TABLE "organisation_centers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organisation_centers" FORCE ROW LEVEL SECURITY;

ALTER TABLE "need_centers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "need_centers" FORCE ROW LEVEL SECURITY;

CREATE POLICY organisation_centers_org_isolation ON "organisation_centers"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY need_centers_org_isolation ON "need_centers"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "organisation_centers", "need_centers" TO cnap_app;
GRANT SELECT ON "organisation_centers", "need_centers" TO cnap_supervisor;

CREATE POLICY organisation_centers_supervisor_read ON "organisation_centers" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY need_centers_supervisor_read ON "need_centers" FOR SELECT TO cnap_supervisor USING (true);

-- report_sharing_requests: no RLS (see comment above), but cnap_app/
-- cnap_supervisor still need explicit grants (no RLS ≠ implicit access —
-- Postgres privileges are independent of RLS policies). Mirrors
-- sharing_requests' own grants exactly (20260716093000_dev1_week2_week3_schema)
-- — no DELETE (requests are never deleted), supervisor is SELECT-only.
GRANT SELECT, INSERT, UPDATE ON "report_sharing_requests" TO cnap_app;
GRANT SELECT ON "report_sharing_requests" TO cnap_supervisor;
