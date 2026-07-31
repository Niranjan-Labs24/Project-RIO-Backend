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
import { StubReportDataProvider } from "./__fixtures__/report-content.fixtures";
import type { ScopedReportQuery, VillageReportQuery } from "./report-data.provider";

// Thin seam MockReportDataProvider calls through — kept separate from the
// provider itself so the real HTTP/analytics client is a drop-in swap later.
// Delegates to StubReportDataProvider for the actual RPT-2026-001 shaped
// content rather than duplicating it.
@Injectable()
export class MockReportApiClient {
  private readonly stub = new StubReportDataProvider();

  fetchVillageReport(query: VillageReportQuery): Promise<VillageReportContent> {
    return this.stub.getVillageReport(query);
  }

  fetchSectorReport(query: ScopedReportQuery): Promise<SectorReportContent> {
    return this.stub.getSectorReport(query);
  }

  fetchRegionReport(query: ScopedReportQuery): Promise<RegionReportContent> {
    return this.stub.getRegionReport(query);
  }

  fetchExecutiveReport(query: ScopedReportQuery): Promise<ExecutiveReportContent> {
    return this.stub.getExecutiveReport(query);
  }

  fetchCollectiveReport(query: ScopedReportQuery): Promise<CollectiveReportContent> {
    return this.stub.getCollectiveReport(query);
  }

  fetchSharingStatus(query: ScopedReportQuery): Promise<SharingStatusContent> {
    return this.stub.getSharingStatus(query);
  }

  fetchCollectiveDashboard(query: ScopedReportQuery): Promise<CollectiveDashboardData> {
    return this.stub.getCollectiveDashboard(query);
  }

  // No SLA source in the mock seam yet — mirrors CollectiveReportContent.kpis.
  async fetchCollectiveKpis(query: ScopedReportQuery): Promise<CollectiveKpis> {
    const { kpis, scoringDistribution } = await this.stub.getCollectiveReport(query);
    return { ...kpis, scoringDistribution };
  }

  // Demographic capture hasn't shipped yet — null drives "Not available" charts.
  async fetchDemographics(_query: ScopedReportQuery): Promise<Demographics | null> {
    return null;
  }
}
