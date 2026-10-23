-- Area profile figures for the Core Needs Report (client, 7 Oct 2026, point
-- 4e): entered annually by the platform team from GASTAT figures. Platform-wide
-- reference data, like regions/governorates/centers: no org_id, no RLS.
CREATE TABLE "area_profiles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "level" VARCHAR(20) NOT NULL,
    "unit_key" VARCHAR(320) NOT NULL,
    "region_id" UUID,
    "governorate_id" UUID,
    "center_id" UUID,
    "village_name" VARCHAR(150),
    "year" INTEGER NOT NULL,
    "population" INTEGER,
    "growth_rate_pct" DECIMAL(6,2),
    "density_per_km2" DECIMAL(12,2),
    "male_pct" DECIMAL(5,2),
    "female_pct" DECIMAL(5,2),
    "saudi_pct" DECIMAL(5,2),
    "rural_pct" DECIMAL(5,2),
    "source" VARCHAR(200) NOT NULL,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "area_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "area_profiles_unit_key_year_key" ON "area_profiles"("unit_key", "year");
CREATE INDEX "area_profiles_level_idx" ON "area_profiles"("level");

-- Reports read it inside an org transaction. System Admin edits go through the
-- app connection (cnap_app), the same as methodology configuration. Delete is
-- granted too: a mistaken entry is removed rather than left as a stale figure
-- in reports.
GRANT SELECT, INSERT, UPDATE, DELETE ON "area_profiles" TO cnap_app;
GRANT SELECT ON "area_profiles" TO cnap_supervisor;
