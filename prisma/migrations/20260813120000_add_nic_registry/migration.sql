-- CreateTable
CREATE TABLE "nic_registry" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "nic_number" VARCHAR(10) NOT NULL,
    "name_en" VARCHAR(500),
    "name_ar" VARCHAR(500),
    "license_number" VARCHAR(50),
    "supervisory_agency_name" VARCHAR(500),
    "license_expiry_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "nic_registry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nic_registry_nic_number_key" ON "nic_registry"("nic_number");

-- Pure reference data, same as "regions"/"governorates"/"centers" — read-only
-- to the app roles at runtime (seeded/re-seeded only via
-- prisma/import-nic-registry.ts, run as the migration owner role). No RLS:
-- this table has no org_id.
GRANT SELECT ON "nic_registry" TO cnap_app;
GRANT SELECT ON "nic_registry" TO cnap_supervisor;
