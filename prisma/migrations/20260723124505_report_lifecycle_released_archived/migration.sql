-- Report lifecycle: draft / rejected / released / archived.
-- Replaces the old `approved` status with `released`, migrating existing rows
-- in the same cast (approved -> released) so no row is ever orphaned.

-- AlterEnum (recreate to drop `approved` and add `released`/`archived`)
CREATE TYPE "ReportStatus_new" AS ENUM ('draft', 'rejected', 'released', 'archived');
ALTER TABLE "reports" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "reports" ALTER COLUMN "status" TYPE "ReportStatus_new"
  USING (
    CASE WHEN "status"::text = 'approved' THEN 'released'
         ELSE "status"::text
    END::"ReportStatus_new"
  );
ALTER TYPE "ReportStatus" RENAME TO "ReportStatus_old";
ALTER TYPE "ReportStatus_new" RENAME TO "ReportStatus";
DROP TYPE "ReportStatus_old";
ALTER TABLE "reports" ALTER COLUMN "status" SET DEFAULT 'draft';

-- Two-step approval + archival columns
ALTER TABLE "reports" ADD COLUMN "officer_confirmed_by" UUID;
ALTER TABLE "reports" ADD COLUMN "officer_confirmed_at" TIMESTAMPTZ(6);
ALTER TABLE "reports" ADD COLUMN "archived_at" TIMESTAMPTZ(6);
