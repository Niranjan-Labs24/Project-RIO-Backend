import type {
  CollectiveDashboardData,
  CollectiveKpis,
  CollectiveReportContent,
  Demographics,
  ExecutiveReportContent,
  RegionReportContent,
  SectorReportContent,
  SharingStatusContent,
  VillageReportContent,
} from "../report-content.types";

// The data-provider seam ("port"). Generators depend ONLY on this abstract
// class — they never know whether the data is mock or real.
//
//   now  → MockReportDataProvider  (fetches the team's mock JSON via MockReportApiClient)
//   later → PrismaReportDataProvider (real analytics tables + real LLM)
//
// Swapping is one binding change in reports.module.ts; no generator,
// controller, contract, or frontend change. Abstract class doubles as the
// Nest DI token (providers: [{ provide: ReportDataProvider, useClass: ... }]).

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

  // RPT02 Collective Dashboard — SLA compliance is a field on the result
  // (mock value now, reviewer-sla module later).
  abstract getCollectiveKpis(query: ScopedReportQuery): Promise<CollectiveKpis>;

  // RPT02 full content (KPIs + executive-summary narrative).
  abstract getCollectiveReport(query: ScopedReportQuery): Promise<CollectiveReportContent>;

  // RPT12 Report Sharing Status — real impl reads ReportSharingRequest.
  abstract getSharingStatus(query: ScopedReportQuery): Promise<SharingStatusContent>;

  // Collective Dashboard aggregate (KPIs + executive summary). SLA compliance
  // is overlaid live by the dashboard service, not returned here.
  abstract getCollectiveDashboard(query: ScopedReportQuery): Promise<CollectiveDashboardData>;

  // Gender/rural — returns null until demographic capture ships, which drives
  // the "Not available" charts (Step 4).
  abstract getDemographics(query: ScopedReportQuery): Promise<Demographics | null>;
}
