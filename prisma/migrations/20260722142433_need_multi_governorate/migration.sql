-- CreateTable
-- Multi-select Governorates for a Need — same org-scoped join-table
-- pattern as NeedCenter/StudyGovernorate.
CREATE TABLE "need_governorates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "need_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "governorate_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "need_governorates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "need_governorates_governorate_id_idx" ON "need_governorates"("governorate_id");

-- CreateIndex
CREATE INDEX "need_governorates_org_id_idx" ON "need_governorates"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "need_governorates_need_id_governorate_id_key" ON "need_governorates"("need_id", "governorate_id");

-- AddForeignKey
ALTER TABLE "need_governorates" ADD CONSTRAINT "need_governorates_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "need_governorates" ADD CONSTRAINT "need_governorates_governorate_id_fkey" FOREIGN KEY ("governorate_id") REFERENCES "governorates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: copy each Need's existing single governorate_id into the new
-- join table before dropping the column, so no data is silently lost.
-- Bypasses RLS the same way the Study migration's cycle_number backfill
-- did — the migration role is the table owner but not a superuser/
-- BYPASSRLS, and needs_org_isolation has no app.current_org_id set here.
ALTER TABLE "needs" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "need_governorates" (need_id, org_id, governorate_id)
SELECT id, org_id, governorate_id FROM "needs" WHERE governorate_id IS NOT NULL;

ALTER TABLE "needs" FORCE ROW LEVEL SECURITY;

-- DropForeignKey
ALTER TABLE "needs" DROP CONSTRAINT "needs_governorate_id_fkey";

-- AlterTable
ALTER TABLE "needs" DROP COLUMN "governorate_id";

-- Org-scoped join table — same RLS isolation pattern as need_centers/
-- study_governorates.
ALTER TABLE "need_governorates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "need_governorates" FORCE ROW LEVEL SECURITY;

CREATE POLICY need_governorates_org_isolation ON "need_governorates"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "need_governorates" TO cnap_app;
GRANT SELECT ON "need_governorates" TO cnap_supervisor;

CREATE POLICY need_governorates_supervisor_read ON "need_governorates" FOR SELECT TO cnap_supervisor USING (true);
