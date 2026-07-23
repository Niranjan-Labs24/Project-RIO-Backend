import { Injectable, Logger } from "@nestjs/common";
import { TenantPrismaService } from "../../../tenancy/tenant-prisma.service";
import type { Demographics } from "../report-content.types";
import type {
  CollectiveDashboardData,
  CollectiveKpis,
  CollectiveReportContent,
  ExecutiveReportContent,
  RegionReportContent,
  SectorReportContent,
  SharingStatusContent,
  VillageReportContent,
} from "../report-content.types";
import {
  ReportSummaryService,
  type ReportDataSnapshot,
  type ScopeFilters,
  type SummaryScopeType,
} from "../report-summary.service";
import { aggregateDemographics } from "./aggregate-demographics";
import { MockReportDataProvider } from "./mock-report-data.provider";
import {
  ReportDataProvider,
  type ScopedReportQuery,
  type VillageReportQuery,
} from "./report-data.provider";
import {
  snapshotToExecutiveContent,
  snapshotToRegionContent,
  snapshotToSectorContent,
  snapshotToVillageContent,
} from "./snapshot-to-content";

// Real report data provider — backed by ReportSummaryService (real DB snapshot
// + Gemini AI narrative) and real survey demographics. Falls back to the mock
// provider only when a study has no scored data yet, so report generation never
// hard-fails on an un-scored study (and existing tests stay green).
@Injectable()
export class ReportSummaryDataProvider extends ReportDataProvider {
  private readonly logger = new Logger(ReportSummaryDataProvider.name);

  constructor(
    private readonly summary: ReportSummaryService,
    private readonly tenant: TenantPrismaService,
    // Cross-study aggregates (collective/sharing) and the no-data fallback.
    private readonly fallback: MockReportDataProvider,
  ) {
    super();
  }

  async getVillageReport(query: VillageReportQuery): Promise<VillageReportContent> {
    try {
      const surveyId = await this.resolveSurveyId(query.studyId, query.filters);
      const { snapshot, aiOutput } = await this.realData(query.studyId, surveyId, "VILLAGE", {
        villageId: query.villageId,
      });
      const demographics = await aggregateDemographics(this.tenant, query.studyId, query.villageId);
      return snapshotToVillageContent({
        snapshot,
        aiOutput,
        assessmentPeriod: query.assessmentPeriod,
        demographics,
        filters: query.filters,
      });
    } catch (err) {
      this.logger.warn(`Village report real data unavailable (${(err as Error).message}); using fallback.`);
      return this.fallback.getVillageReport(query);
    }
  }

  async getSectorReport(query: ScopedReportQuery): Promise<SectorReportContent> {
    try {
      if (!query.studyId) throw new Error("studyId required");
      const surveyId = await this.resolveSurveyId(query.studyId, query.filters);
      const { snapshot, aiOutput } = await this.realData(query.studyId, surveyId, "SECTOR", {
        domainKey: typeof query.filters.domainKey === "string" ? query.filters.domainKey : undefined,
      });
      return snapshotToSectorContent({ snapshot, aiOutput, filters: query.filters });
    } catch (err) {
      this.logger.warn(`Sector report real data unavailable (${(err as Error).message}); using fallback.`);
      return this.fallback.getSectorReport(query);
    }
  }

  async getRegionReport(query: ScopedReportQuery): Promise<RegionReportContent> {
    try {
      if (!query.studyId) throw new Error("studyId required");
      const surveyId = await this.resolveSurveyId(query.studyId, query.filters);
      const { snapshot, aiOutput } = await this.realData(query.studyId, surveyId, "REGION", {
        regionId: typeof query.filters.regionId === "string" ? query.filters.regionId : undefined,
      });
      return snapshotToRegionContent({ snapshot, aiOutput, filters: query.filters });
    } catch (err) {
      this.logger.warn(`Region report real data unavailable (${(err as Error).message}); using fallback.`);
      return this.fallback.getRegionReport(query);
    }
  }

  async getExecutiveReport(query: ScopedReportQuery): Promise<ExecutiveReportContent> {
    try {
      if (!query.studyId) throw new Error("studyId required");
      const surveyId = await this.resolveSurveyId(query.studyId, query.filters);
      const { snapshot, aiOutput } = await this.realData(query.studyId, surveyId, "EXECUTIVE", {});
      return snapshotToExecutiveContent({ snapshot, aiOutput, filters: query.filters });
    } catch (err) {
      this.logger.warn(`Executive report real data unavailable (${(err as Error).message}); using fallback.`);
      return this.fallback.getExecutiveReport(query);
    }
  }

  // Cross-study aggregates aren't per-scope snapshots — keep them on the
  // existing (mock) path until a real aggregation task lands.
  getCollectiveKpis(query: ScopedReportQuery): Promise<CollectiveKpis> {
    return this.fallback.getCollectiveKpis(query);
  }
  getCollectiveReport(query: ScopedReportQuery): Promise<CollectiveReportContent> {
    return this.fallback.getCollectiveReport(query);
  }
  getSharingStatus(query: ScopedReportQuery): Promise<SharingStatusContent> {
    return this.fallback.getSharingStatus(query);
  }
  getCollectiveDashboard(query: ScopedReportQuery): Promise<CollectiveDashboardData> {
    return this.fallback.getCollectiveDashboard(query);
  }
  getDemographics(query: ScopedReportQuery): Promise<Demographics | null> {
    return this.fallback.getDemographics(query);
  }

  // ── internals ──

  private async resolveSurveyId(studyId: string, filters: Record<string, unknown>): Promise<string> {
    if (typeof filters.surveyId === "string" && filters.surveyId) return filters.surveyId;
    const survey = await this.tenant.runInOrgContext((tx) =>
      tx.survey.findFirst({ where: { studyId }, orderBy: { createdAt: "desc" } }),
    );
    if (!survey) throw new Error(`no survey for study ${studyId}`);
    return survey.id;
  }

  // Reuse an existing AI summary; otherwise build the snapshot and (best-effort)
  // generate one. Throws "no-data" when the study has no scores yet → fallback.
  private async realData(
    studyId: string,
    surveyId: string,
    scope: SummaryScopeType,
    scopeFilters: ScopeFilters,
  ): Promise<{ snapshot: ReportDataSnapshot; aiOutput: Record<string, unknown> | null }> {
    const existing = await this.summary.getSummary(studyId, surveyId, scope, scopeFilters.villageId ?? "");
    if (existing && this.hasData(existing.snapshot)) {
      const s = existing.summary as { officerEditedOutputJson?: unknown; aiOutputJson?: unknown };
      return {
        snapshot: existing.snapshot,
        aiOutput: (s.officerEditedOutputJson ?? s.aiOutputJson ?? null) as Record<string, unknown> | null,
      };
    }

    const { snapshot } = await this.summary.buildReportDataSnapshot(studyId, surveyId, scope, scopeFilters);
    if (!this.hasData(snapshot)) throw new Error("no-data");

    // Real data exists but no saved summary — generate one (reuse-then-generate).
    // If AI is unavailable (e.g. no GEMINI key), still return the real snapshot.
    let aiOutput: Record<string, unknown> | null = null;
    try {
      const gen = await this.summary.generatePrioritySummary(studyId, surveyId, scope, scopeFilters);
      aiOutput = ((gen.summary as { aiOutputJson?: unknown }).aiOutputJson ?? null) as Record<string, unknown> | null;
    } catch (err) {
      this.logger.warn(`AI summary generation skipped (${(err as Error).message}); returning data without narrative.`);
    }
    return { snapshot, aiOutput };
  }

  private hasData(s: ReportDataSnapshot): boolean {
    return (
      (s.severity.overallVillageNeedsIndex as number | null) !== null &&
      (s.priority.villagePriorityScore as number | null) !== null
    );
  }
}
