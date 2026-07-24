import { Injectable } from "@nestjs/common";
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
import { MockReportApiClient } from "./mock-report-api.client";
import {
  ReportDataProvider,
  type ScopedReportQuery,
  type VillageReportQuery,
} from "./report-data.provider";

// Mock implementation of the provider port — delegates to MockReportApiClient
// (a call, not a static import), so the real provider is a drop-in swap. Bound
// in reports.module.ts as the ReportDataProvider today.
@Injectable()
export class MockReportDataProvider extends ReportDataProvider {
  constructor(private readonly api: MockReportApiClient) {
    super();
  }

  getVillageReport(query: VillageReportQuery): Promise<VillageReportContent> {
    return this.api.fetchVillageReport(query);
  }

  getSectorReport(query: ScopedReportQuery): Promise<SectorReportContent> {
    return this.api.fetchSectorReport(query);
  }

  getRegionReport(query: ScopedReportQuery): Promise<RegionReportContent> {
    return this.api.fetchRegionReport(query);
  }

  getExecutiveReport(query: ScopedReportQuery): Promise<ExecutiveReportContent> {
    return this.api.fetchExecutiveReport(query);
  }

  getCollectiveKpis(query: ScopedReportQuery): Promise<CollectiveKpis> {
    return this.api.fetchCollectiveKpis(query);
  }

  getCollectiveReport(query: ScopedReportQuery): Promise<CollectiveReportContent> {
    return this.api.fetchCollectiveReport(query);
  }

  getSharingStatus(query: ScopedReportQuery): Promise<SharingStatusContent> {
    return this.api.fetchSharingStatus(query);
  }

  getCollectiveDashboard(query: ScopedReportQuery): Promise<CollectiveDashboardData> {
    return this.api.fetchCollectiveDashboard(query);
  }

  getDemographics(query: ScopedReportQuery): Promise<Demographics | null> {
    return this.api.fetchDemographics(query);
  }
}
