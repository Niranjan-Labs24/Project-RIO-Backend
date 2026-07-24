-- AlterTable
ALTER TABLE "needs" ADD COLUMN     "ai_suggested_domain" VARCHAR(120),
ADD COLUMN     "ai_suggested_sub_domain" VARCHAR(120);

-- CreateTable
CREATE TABLE "methodology_version_options" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "version" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "methodology_version_options_pkey" PRIMARY KEY ("id")
);

-- TEMPORARY seed data — see the model comment in schema.prisma. The first
-- row mirrors the label already live in the single `methodology_configs`
-- row (kept in sync manually for now, since there's no relation between the
-- two tables); the second is a clearly-marked placeholder so the selector
-- is demonstrably a real list, not a disabled single-option stand-in.
INSERT INTO "methodology_version_options" ("version", "is_active", "sort_order") VALUES
  ('v1.0 - Approved implementation baseline', true, 0),
  ('v1.1-draft (placeholder — awaiting methodology versioning source)', true, 1);
