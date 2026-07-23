export const REPORT_TYPES = [
  "RPT01", "RPT02", "RPT03", "RPT04", "RPT05", "RPT06",
  "RPT07", "RPT08", "RPT09", "RPT10", "RPT11", "RPT12", "RPT13", "RPT14",
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
  { name: string; kind: "report" | "dashboard" | "log"; exportFormats: ExportFormat[]; requiresStudyId: boolean }
> = {
  RPT01: { name: "Individual Study Report", kind: "report", exportFormats: ["pdf", "excel"], requiresStudyId: true },
  RPT02: { name: "Collective Report / Dashboard", kind: "dashboard", exportFormats: ["pdf", "excel"], requiresStudyId: false },
  RPT03: { name: "Top Needs View", kind: "dashboard", exportFormats: ["pdf", "excel"], requiresStudyId: false },
  RPT04: { name: "Domain-wise Needs", kind: "dashboard", exportFormats: ["pdf", "excel"], requiresStudyId: true },
  RPT05: { name: "Governorate-wise Needs", kind: "dashboard", exportFormats: ["pdf", "excel"], requiresStudyId: false },
  RPT06: { name: "Region/Governorate Filtering", kind: "dashboard", exportFormats: ["pdf", "excel"], requiresStudyId: true },
  RPT07: { name: "Gender-wise Needs", kind: "report", exportFormats: ["pdf", "excel"], requiresStudyId: false },
  RPT08: { name: "KPI Results", kind: "dashboard", exportFormats: ["excel"], requiresStudyId: false },
  RPT09: { name: "Priority Ranking", kind: "dashboard", exportFormats: ["pdf", "excel"], requiresStudyId: false },
  RPT10: { name: "Data Quality Indicators", kind: "dashboard", exportFormats: ["excel"], requiresStudyId: false },
  RPT11: { name: "Previous Studies View", kind: "dashboard", exportFormats: [], requiresStudyId: false },
  RPT12: { name: "Report Sharing Status", kind: "log", exportFormats: ["pdf", "excel"], requiresStudyId: false },
  RPT13: { name: "Executive Summary", kind: "report", exportFormats: ["pdf", "excel"], requiresStudyId: true },
  RPT14: { name: "Village Report", kind: "report", exportFormats: ["pdf", "excel"], requiresStudyId: true },
};

export interface ReportRow {
  id: string;
  orgId: string;
  reportType: ReportTypeCode;
  status: ReportStatus;
  title: string;
  studyId: string | null;
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
  filters: Record<string, unknown>;
  content: Record<string, unknown>;
  generatedBy: string;
  generatedAt: string;
  officerConfirmedBy: string | null;
  officerConfirmedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  archivedAt: string | null;
  exportFormats: ExportFormat[];
}

export interface CreateReportPayload {
  reportType: ReportTypeCode;
  studyId?: string;
  filters?: Record<string, unknown>;
}

export interface ListReportsParams {
  reportType?: ReportTypeCode;
  status?: ReportStatus;
  studyId?: string;
}
