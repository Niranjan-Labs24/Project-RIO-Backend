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
import { PriorityV2Service } from "../../priority/priority-v2.service";
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
    // Authoritative org-wide priority rows for the collective dashboard —
    // the same source the Priority Dashboard reads, so the two reconcile.
    private readonly priorityV2: PriorityV2Service,
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
  // Collective dashboard — REAL org-wide aggregation. Needs count + scoring
  // distribution + top priorities come from the same VillagePriorityAssessment
  // rows the Priority Dashboard reads (so the two reconcile); anomalies from
  // ResponseQualityResult flags; reviewer notes from decided AiDecisions. An
  // org with no needs yet returns real zeros (not the Sample-Village mock);
  // only an unexpected error falls back to the mock so the screen never dies.
  async getCollectiveDashboard(query: ScopedReportQuery): Promise<CollectiveDashboardData> {
    try {
      // Authoritative scores — identical to the Priority Dashboard's rows.
      const entries = await this.priorityV2.listForOrg();

      const { needCount, needById, lowConfidenceCount, duplicateCount, reviewerNotes } =
        await this.tenant.runInOrgContext(async (tx) => {
          const [needCount, needs, quality, decisions] = await Promise.all([
            tx.need.count(),
            tx.need.findMany({
              select: { id: true, statement: true, title: true, domain: true, village: true, studyId: true },
            }),
            tx.responseQualityResult.findMany({ select: { confidenceFlag: true, isDuplicate: true } }),
            tx.aiDecision.findMany({
              where: { decidedAt: { not: null } },
              orderBy: { decidedAt: "desc" },
            }),
          ]);

          // Reviewer notes = decided AiDecisions that carry free-text notes.
          const noted = decisions
            .map((d) => ({ d, hd: d.humanDecision as { notes?: string | null } | null }))
            .filter((x) => typeof x.hd?.notes === "string" && x.hd.notes.trim().length > 0)
            .slice(0, 5);
          const authorIds = Array.from(
            new Set(noted.map((x) => x.d.decidedBy).filter((id): id is string => id !== null)),
          );
          const authors =
            authorIds.length === 0
              ? []
              : await tx.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } });
          const authorName = new Map(authors.map((u) => [u.id, u.name]));

          return {
            needCount,
            needById: new Map(needs.map((n) => [n.id, n])),
            lowConfidenceCount: quality.filter((q) => q.confidenceFlag === "low").length,
            duplicateCount: quality.filter((q) => q.isDuplicate).length,
            reviewerNotes: noted.map((x) => ({
              author: (x.d.decidedBy && authorName.get(x.d.decidedBy)) || "Reviewer",
              note: (x.hd!.notes as string).trim(),
              at: x.d.decidedAt!.toISOString(),
            })),
          };
        });

      // Empty org → honest zeros, not the mock fixtures.
      if (needCount === 0) {
        return { needCount: 0, scoringDistribution: [], topPriorities: [], trends: [], anomalies: [], reviewerNotes: [] };
      }

      const scored = entries.filter((e): e is typeof e & { score: NonNullable<typeof e.score> } => e.score !== null);

      // Scoring distribution: fold the four priority levels into the three
      // reporting bands (critical rolls up into High).
      const bandOf = (level: string): "High" | "Medium" | "Low" =>
        level === "critical" || level === "high" ? "High" : level === "medium" ? "Medium" : "Low";
      const bandCounts = { High: 0, Medium: 0, Low: 0 };
      for (const e of scored) bandCounts[bandOf(e.score.level)] += 1;
      const scoringDistribution = [
        { band: "High", count: bandCounts.High },
        { band: "Medium", count: bandCounts.Medium },
        { band: "Low", count: bandCounts.Low },
      ];

      // Top priorities: most-urgent first (critical → high → medium → low),
      // then by weighted severity. v2's priorityScore is performance-weighted
      // (lower = more urgent), so severity = 100 − score reads higher-is-worse
      // in the "Severity" column, consistent with the per-scope reports.
      const levelRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
      const topPriorities = [...scored]
        .map((e) => ({ e, severity: Math.round(100 - e.score.overallScore) }))
        .sort((a, b) => levelRank[a.e.score.level] - levelRank[b.e.score.level] || b.severity - a.severity)
        .slice(0, 5)
        .map(({ e, severity }, i) => {
          const need = needById.get(e.needId);
          return {
            rank: i + 1,
            label: need?.statement || need?.title || "Need",
            domain: need?.domain || "Unclassified",
            severityScore: severity,
            entity: need?.village?.[0] || e.studyTitle,
          };
        });

      // Anomalies: derived from real response-quality flags.
      const anomalies: CollectiveDashboardData["anomalies"] = [];
      if (lowConfidenceCount > 0)
        anomalies.push({
          severity: "warning",
          note: `${lowConfidenceCount} response(s) flagged Low Confidence — findings should be field-validated.`,
        });
      if (duplicateCount > 0)
        anomalies.push({
          severity: "info",
          note: `${duplicateCount} potential duplicate response(s) detected.`,
        });

      // Trends need a prior assessment cycle to compare against; none is stored
      // yet, so surface an honest placeholder (same as the village report).
      const trends: CollectiveDashboardData["trends"] = [
        { label: "Assessment trend", direction: "flat", note: "Trend pending — first assessment cycle." },
      ];

      return { needCount, scoringDistribution, topPriorities, trends, anomalies, reviewerNotes };
    } catch (err) {
      this.logger.warn(`Collective dashboard real data unavailable (${(err as Error).message}); using fallback.`);
      return this.fallback.getCollectiveDashboard(query);
    }
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
