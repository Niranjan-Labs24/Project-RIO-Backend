-- AlterEnum
-- The two study-scoped evidence reports.
--
-- RPT17 "Evidence Document-Based Report" carries only the study's uploaded
-- evidence documents and their officer-confirmed AI summaries. RPT16 "Combined
-- Evidence & Score Report" is the same evidence plus the quantitative
-- severity/priority half, so the two are separate report types rather than one
-- report with a flag: they are generated, reviewed and shared independently.
--
-- RPT17 exists because RPT15 was taken by the Survey & Dashboard Report in
-- 20260728100000_add_rpt15_combined_report; the evidence report was moved off
-- RPT15 rather than renumbering an already-released type.
--
-- Kept in its own migration (as with 20260723065558_add_rpt14_village_report
-- and the RPT15 migration) because Postgres forbids using a newly added enum
-- value in the same transaction that adds it.
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'RPT16';
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'RPT17';
