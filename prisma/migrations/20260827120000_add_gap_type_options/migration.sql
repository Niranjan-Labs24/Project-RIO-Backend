-- Gap Types becomes a configurable list (client correction 2026-08-27,
-- superseding RIO-FR-005 Q12's "five fixed values, final") — same shape as
-- study_type_options/target_sector_options/decision_type_options.
CREATE TABLE "gap_type_options" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" VARCHAR(100) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gap_type_options_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gap_type_options_name_key" ON "gap_type_options"("name");

GRANT SELECT, INSERT, UPDATE ON "gap_type_options" TO cnap_app;
GRANT SELECT ON "gap_type_options" TO cnap_supervisor;
