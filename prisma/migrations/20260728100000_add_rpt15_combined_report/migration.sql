-- AlterEnum
-- RPT15 "Combined Survey + Dashboard Report". Kept in its own migration (same
-- as 20260723065558_add_rpt14_village_report) because Postgres forbids using a
-- newly added enum value in the same transaction that adds it — the backfill in
-- the next migration reads report_type.
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'RPT15';
