-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "center_id" UUID,
ADD COLUMN     "governorate_id" UUID,
ADD COLUMN     "region_id" UUID;

-- CreateTable
CREATE TABLE "regions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" INTEGER NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "iso_code" VARCHAR(10) NOT NULL,
    "capital" VARCHAR(150) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governorates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(10) NOT NULL,
    "region_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "category" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "governorates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "centers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(20) NOT NULL,
    "governorate_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "category" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "centers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "regions_code_key" ON "regions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "regions_iso_code_key" ON "regions"("iso_code");

-- CreateIndex
CREATE UNIQUE INDEX "governorates_code_key" ON "governorates"("code");

-- CreateIndex
CREATE INDEX "governorates_region_id_idx" ON "governorates"("region_id");

-- CreateIndex
CREATE UNIQUE INDEX "centers_code_key" ON "centers"("code");

-- CreateIndex
CREATE INDEX "centers_governorate_id_idx" ON "centers"("governorate_id");

-- CreateIndex
CREATE INDEX "organisations_region_id_idx" ON "organisations"("region_id");

-- CreateIndex
CREATE INDEX "organisations_governorate_id_idx" ON "organisations"("governorate_id");

-- CreateIndex
CREATE INDEX "organisations_center_id_idx" ON "organisations"("center_id");

-- AddForeignKey
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_governorate_id_fkey" FOREIGN KEY ("governorate_id") REFERENCES "governorates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_center_id_fkey" FOREIGN KEY ("center_id") REFERENCES "centers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "governorates" ADD CONSTRAINT "governorates_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "centers" ADD CONSTRAINT "centers_governorate_id_fkey" FOREIGN KEY ("governorate_id") REFERENCES "governorates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Pure reference data, same as "questions" — read-only to cnap_app at
-- runtime (seeded/re-seeded only via prisma/import-geography.ts, run as the
-- migration owner role). No RLS: these tables have no org_id.
GRANT SELECT ON "regions", "governorates", "centers" TO cnap_app;
GRANT SELECT ON "regions", "governorates", "centers" TO cnap_supervisor;
