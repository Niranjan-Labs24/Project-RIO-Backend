export const REPORT_TYPES = [
  "RPT01", "RPT02", "RPT03", "RPT04", "RPT05", "RPT06",
  "RPT07", "RPT08", "RPT09", "RPT10", "RPT11", "RPT12", "RPT13", "RPT14", "RPT15",
  "RPT16", "RPT17",
] as const;
export type ReportTypeCode = (typeof REPORT_TYPES)[number];

export type ReportStatus = "draft" | "rejected" | "released" | "archived";
export type ExportFormat = "pdf" | "excel";

// Statuses a report may be exported/shared from — reviewer approval (release)
// is required first; archived stays exportable but read-only.
export const EXPORTABLE_STATUSES: ReportStatus[] = ["released", "archived"];

/** Mirrors new scope.md §9's Reports & Dashboards table exactly. */
export const REPORT_TYPE_META: Record<
  ReportTypeCode,
  {
    name: string;
    kind: "report" | "dashboard" | "log";
    exportFormats: ExportFormat[];
    requiresStudyId: boolean;
    // Survey-scoped types (RPT01/RPT15) are generated from ONE survey, so the
    // caller must name it — see ReportsService.create's SURVEY_ID_REQUIRED
    // check. Implies requiresStudyId (the survey is validated to belong to it).
    requiresSurveyId: boolean;
  }
> = {
  RPT01: { name: "Individual Survey Report", kind: "report", exportFormats: ["pdf", "excel"], requiresStudyId: true, requiresSurveyId: true },
  RPT02: { name: "Collective Report / Dashboard", kind: "dashboard", exportFormats: ["pdf", "excel"], requiresStudyId: false, requiresSurveyId: false },
  RPT03: { name: "Top Needs View", kind: "dashboard", exportFormats: ["pdf", "excel"], requiresStudyId: false, requiresSurveyId: false },
  RPT04: { name: "Domain-wise Needs", kind: "dashboard", exportFormats: ["pdf", "excel"], requiresStudyId: true, requiresSurveyId: false },
  RPT05: { name: "Governorate-wise Needs", kind: "dashboard", exportFormats: ["pdf", "excel"], requiresStudyId: false, requiresSurveyId: false },
  RPT06: { name: "Region/Governorate Filtering", kind: "dashboard", exportFormats: ["pdf", "excel"], requiresStudyId: true, requiresSurveyId: false },
  RPT07: { name: "Gender-wise Needs", kind: "report", exportFormats: ["pdf", "excel"], requiresStudyId: false, requiresSurveyId: false },
  RPT08: { name: "KPI Results", kind: "dashboard", exportFormats: ["excel"], requiresStudyId: false, requiresSurveyId: false },
  RPT09: { name: "Priority Ranking", kind: "dashboard", exportFormats: ["pdf", "excel"], requiresStudyId: false, requiresSurveyId: false },
  RPT10: { name: "Data Quality Indicators", kind: "dashboard", exportFormats: ["excel"], requiresStudyId: false, requiresSurveyId: false },
  RPT11: { name: "Previous Studies View", kind: "dashboard", exportFormats: [], requiresStudyId: false, requiresSurveyId: false },
  RPT12: { name: "Report Sharing Status", kind: "log", exportFormats: ["pdf", "excel"], requiresStudyId: false, requiresSurveyId: false },
  RPT13: { name: "Executive Summary", kind: "report", exportFormats: ["pdf", "excel"], requiresStudyId: true, requiresSurveyId: false },
  RPT14: { name: "Village Report", kind: "report", exportFormats: ["pdf", "excel"], requiresStudyId: true, requiresSurveyId: false },
  RPT15: { name: "Survey & Dashboard Report", kind: "report", exportFormats: ["pdf", "excel"], requiresStudyId: true, requiresSurveyId: true },
  // Study-scoped evidence reports. Both are built from the study's uploaded
  // evidence documents and their officer-confirmed AI summaries, so neither
  // names a survey. RPT17 carries the documents alone; RPT16 adds the
  // quantitative severity/priority half on top of the same evidence.
  RPT16: { name: "Combined Evidence & Score Report", kind: "report", exportFormats: ["pdf", "excel"], requiresStudyId: true, requiresSurveyId: false },
  RPT17: { name: "Evidence Document-Based Report", kind: "report", exportFormats: ["pdf", "excel"], requiresStudyId: true, requiresSurveyId: false },
};

export interface ReportRow {
  id: string;
  orgId: string;
  reportType: ReportTypeCode;
  status: ReportStatus;
  title: string;
  studyId: string | null;
  surveyId: string | null;
  filters: unknown;
  content: unknown;
  generatedBy: string;
  generatedAt: Date;
  officerConfirmedBy: string | null;
  officerConfirmedAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  archivedAt: Date | null;
}

export interface Report {
  id: string;
  reportType: ReportTypeCode;
  status: ReportStatus;
  title: string;
  studyId: string | null;
  surveyId: string | null;
  // Resolved display name for surveyId, so the reports list can show which
  // survey a survey-scoped report came from without a second round-trip.
  surveyTitle: string | null;
  filters: Record<string, unknown>;
  content: Record<string, unknown>;
  generatedBy: string;
  generatedByName: string | null;
  generatedAt: string;
  officerConfirmedBy: string | null;
  officerConfirmedByName: string | null;
  officerConfirmedAt: string | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  // Reviewer's role name (e.g. "Reviewer/Approver", "Center Supervisor") for
  // audit clarity — who, in what capacity, approved the report.
  reviewedByRole: string | null;
  reviewedAt: string | null;
  archivedAt: string | null;
  exportFormats: ExportFormat[];
}

export interface CreateReportPayload {
  reportType: ReportTypeCode;
  studyId?: string;
  surveyId?: string;
  filters?: Record<string, unknown>;
}

export interface ListReportsParams {
  organizationId?: string;
  reportType?: ReportTypeCode;
  status?: ReportStatus;
  studyId?: string;
  surveyId?: string;
  limit?: number;
  offset?: number;
}
