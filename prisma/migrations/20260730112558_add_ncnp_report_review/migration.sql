-- Purely additive — new enum, new table, one new PermissionModule value.
-- Nothing existing is altered or dropped.
--
-- ncnp_report_reviews: the NCNP Compiled Report's own approval workflow
-- (System Admin generates -> System Reviewer approves/rejects with
-- mandatory notes -> System Admin publishes). Deliberately not a `reports`
-- row: that table is org-scoped (required org_id, cascading delete, RLS),
-- but the NCNP Compiled Report is kingdom-wide/cross-org. No org_id, no
-- RLS here — same "global reference data" pattern already used by
-- domains/methodology_versions/roles.
--
-- PermissionModule.ncnpReport: a dedicated module rather than reusing
-- reportsDashboards, since that would also grant System Reviewer approve
-- rights over the unrelated RPT01-14 Reports feature (its controller has
-- no crossEntity guard of its own).

-- CreateEnum
CREATE TYPE "NcnpReportReviewStatus" AS ENUM ('draft', 'approved', 'rejected', 'released');

-- AlterEnum
ALTER TYPE "PermissionModule" ADD VALUE 'ncnpReport';

-- CreateTable
CREATE TABLE "ncnp_report_reviews" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "status" "NcnpReportReviewStatus" NOT NULL DEFAULT 'draft',
    "content" JSONB NOT NULL,
    "filters" JSONB NOT NULL,
    "generated_by" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "reviewer_notes" VARCHAR(2000),
    "published_by" UUID,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "ncnp_report_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ncnp_report_reviews_status_idx" ON "ncnp_report_reviews"("status");
