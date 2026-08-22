-- RIO-FR-012/NFR-014 — Study Type and Target Sector as configurable lists
-- managed from Methodology Configuration, per Sprint 2 clarification Q3/Q4:
-- "Both Study Type and Target Sector values should be configurable via
-- Methodology Configuration rather than hardcoded." The actual value list
-- itself is still pending (Q35 follow-up sent) — these tables start empty
-- and are populated once that answer lands; the admin UI works today with
-- whatever values a System Admin adds in the meantime.

CREATE TABLE "study_type_options" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "name" VARCHAR(100) NOT NULL,
  "display_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "study_type_options_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "study_type_options_name_key" ON "study_type_options"("name");

CREATE TABLE "target_sector_options" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "name" VARCHAR(100) NOT NULL,
  "display_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "target_sector_options_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "target_sector_options_name_key" ON "target_sector_options"("name");

GRANT SELECT, INSERT, UPDATE ON "study_type_options", "target_sector_options" TO cnap_app;
GRANT SELECT ON "study_type_options", "target_sector_options" TO cnap_supervisor;

-- Target Sector counterpart to the existing Study.study_type column —
-- same shape (nullable, validated against the option table's `name` at the
-- API layer, not an FK — see the schema.prisma comment on both columns).
ALTER TABLE "studies" ADD COLUMN "target_sector" VARCHAR(100);
