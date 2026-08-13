-- Client-confirmed (Aug 13): distinct "confirmed, awaiting Reviewer" status
-- for Reports, so Report.status stops reading as unchanged "draft" after
-- ReportsService.confirm() runs. Purely additive to the enum — existing rows
-- and the Officer-confirm/Reviewer-approve two-step flow are untouched.
ALTER TYPE "ReportStatus" ADD VALUE 'submitted';
