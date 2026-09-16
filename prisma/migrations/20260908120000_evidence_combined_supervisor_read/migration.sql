-- Fixes a genuine, previously-undetected gap: cnap_supervisor could not
-- SELECT from evidence_documents / evidence_document_chunks /
-- evidence_document_summaries / combined_report_summaries /
-- combined_report_evidence_sources, surfacing as a live "permission denied
-- for table evidence_documents" (Postgres code 42501) once
-- CombinedReportSummaryService.getCombinedReportContext() and
-- ReportSummaryService.buildReportDataSnapshot() were switched to
-- runAsSupervisor (2026-09-08, RIO-RBAC-002 follow-up) so System Admin/
-- Reviewer/Center Supervisor can open the Combined Summary / AI Priority
-- Summary tabs on a study belonging to a different org.
--
-- Root cause: 20260807010000_evidence_persistence already contains both the
-- CREATE POLICY *_supervisor_read statements for these 5 tables AND the
-- matching GRANT SELECT — but `_prisma_migrations` shows two rows for that
-- migration name, one with a NULL finished_at (a failed run) and one
-- recorded as finished. The RLS policies exist on this database (confirmed
-- via pg_policies), but the GRANT never took — the failed run's partial
-- work plus a later `migrate resolve --applied` masked the gap rather than
-- re-running the file. This migration repairs only the missing half; the
-- policies are left alone since CREATE POLICY would fail as "already
-- exists" if repeated here.
GRANT SELECT ON "evidence_documents" TO cnap_supervisor;
GRANT SELECT ON "evidence_document_chunks" TO cnap_supervisor;
GRANT SELECT ON "evidence_document_summaries" TO cnap_supervisor;
GRANT SELECT ON "combined_report_summaries" TO cnap_supervisor;
GRANT SELECT ON "combined_report_evidence_sources" TO cnap_supervisor;
