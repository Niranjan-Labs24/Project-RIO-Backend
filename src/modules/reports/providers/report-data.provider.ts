import type {
  CollectiveDashboardData,
  CollectiveReportContent,
  ExecutiveReportContent,
  RegionReportContent,
  SectorReportContent,
  SharingStatusContent,
  VillageReportContent,
} from "../report-content.types";

// The data-provider seam ("port"). Generators depend ONLY on this abstract
// class — they never reach for Prisma or an AI client themselves.
//
// Bound to ReportSummaryDataProvider (real DB snapshot + Gemini narrative +
// real survey demographics) in reports.module.ts. Abstract class doubles as
// the Nest DI token (providers: [{ provide: ReportDataProvider, useClass: ... }]).

export interface VillageReportQuery {
  studyId: string;
  studyTitle?: string;
  assessmentCycle?: number;
  assessmentPeriod?: string;
  villageId: string;
  orgId: string;
  filters: Record<string, unknown>;
}

export interface ScopedReportQuery {
  studyId?: string;
  studyTitle?: string;
  orgId: string;
  filters: Record<string, unknown>;
}

export abstract class ReportDataProvider {
  abstract getVillageReport(query: VillageReportQuery): Promise<VillageReportContent>;
  abstract getSectorReport(query: ScopedReportQuery): Promise<SectorReportContent>;
  abstract getRegionReport(query: ScopedReportQuery): Promise<RegionReportContent>;
  abstract getExecutiveReport(query: ScopedReportQuery): Promise<ExecutiveReportContent>;

  // RPT02 full content (KPIs + executive-summary narrative).
  abstract getCollectiveReport(query: ScopedReportQuery): Promise<CollectiveReportContent>;

  // RPT12 Report Sharing Status — reads ReportSharingRequest.
  abstract getSharingStatus(query: ScopedReportQuery): Promise<SharingStatusContent>;

  // Collective Dashboard aggregate (KPIs + executive summary). SLA compliance
  // is overlaid live by the dashboard service, not returned here.
  abstract getCollectiveDashboard(query: ScopedReportQuery): Promise<CollectiveDashboardData>;
}
