-- AlterTable
ALTER TABLE "studies" DROP COLUMN "governorate_id",
ADD COLUMN     "cycle_number" INTEGER,
ADD COLUMN     "methodology_version_id" UUID;

-- Backfill: assign sequential per-org cycle numbers to any pre-existing
-- Study rows (ordered by created_at) before the column is made NOT NULL.
-- Temporarily lift FORCE RLS so the migration role (table owner, not
-- superuser/BYPASSRLS) can see and update rows across all orgs — the
-- studies_org_isolation policy has no app.current_org_id set here.
ALTER TABLE "studies" NO FORCE ROW LEVEL SECURITY;

UPDATE "studies" AS s
SET "cycle_number" = ranked.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY org_id ORDER BY created_at) AS rn
  FROM "studies"
) AS ranked
WHERE s.id = ranked.id;

ALTER TABLE "studies" FORCE ROW LEVEL SECURITY;

ALTER TABLE "studies" ALTER COLUMN "cycle_number" SET NOT NULL;

-- CreateTable
CREATE TABLE "study_governorates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "study_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "governorate_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_governorates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_centers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "study_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "center_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_centers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "study_governorates_governorate_id_idx" ON "study_governorates"("governorate_id");

-- CreateIndex
CREATE INDEX "study_governorates_org_id_idx" ON "study_governorates"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "study_governorates_study_id_governorate_id_key" ON "study_governorates"("study_id", "governorate_id");

-- CreateIndex
CREATE INDEX "study_centers_center_id_idx" ON "study_centers"("center_id");

-- CreateIndex
CREATE INDEX "study_centers_org_id_idx" ON "study_centers"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "study_centers_study_id_center_id_key" ON "study_centers"("study_id", "center_id");

-- CreateIndex
CREATE UNIQUE INDEX "studies_org_id_cycle_number_key" ON "studies"("org_id", "cycle_number");

-- AddForeignKey
ALTER TABLE "studies" ADD CONSTRAINT "studies_methodology_version_id_fkey" FOREIGN KEY ("methodology_version_id") REFERENCES "methodology_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_governorates" ADD CONSTRAINT "study_governorates_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_governorates" ADD CONSTRAINT "study_governorates_governorate_id_fkey" FOREIGN KEY ("governorate_id") REFERENCES "governorates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_centers" ADD CONSTRAINT "study_centers_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_centers" ADD CONSTRAINT "study_centers_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Org-scoped join tables — same RLS isolation pattern as
-- organisation_centers/need_centers (20260722084250_geography_hierarchy_rework).
ALTER TABLE "study_governorates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "study_governorates" FORCE ROW LEVEL SECURITY;

ALTER TABLE "study_centers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "study_centers" FORCE ROW LEVEL SECURITY;

CREATE POLICY study_governorates_org_isolation ON "study_governorates"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY study_centers_org_isolation ON "study_centers"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "study_governorates", "study_centers" TO cnap_app;
GRANT SELECT ON "study_governorates", "study_centers" TO cnap_supervisor;

CREATE POLICY study_governorates_supervisor_read ON "study_governorates" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY study_centers_supervisor_read ON "study_centers" FOR SELECT TO cnap_supervisor USING (true);
