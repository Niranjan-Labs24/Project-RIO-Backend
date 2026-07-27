import { ConflictException, Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { TenantPrismaService } from "../../../tenancy/tenant-prisma.service";
import type {
  CollectiveDashboardData,
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
import { ReportSharingService } from "../../report-sharing/report-sharing.service";
import { ReviewerSlaService } from "../../reviewer-sla/reviewer-sla.service";
import { slaComplianceFromAlerts } from "../../reviewer-sla/sla-compliance";
import { aggregateDemographics } from "./aggregate-demographics";
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

// Real report data provider — every method reads real data. There is no mock
// fallback: a study with no scores yet raises STUDY_NOT_SCORED (409) so the
// caller can act on it, and an infrastructure fault propagates as a 500. Both
// used to be answered with fixtures, which could be confirmed, approved and
// exported with nothing in the document marking the data as fake.
@Injectable()
export class ReportSummaryDataProvider extends ReportDataProvider {
  private readonly logger = new Logger(ReportSummaryDataProvider.name);

  constructor(
    private readonly summary: ReportSummaryService,
    private readonly tenant: TenantPrismaService,
    // Authoritative org-wide priority rows for the collective dashboard —
    // the same source the Priority Dashboard reads, so the two reconcile.
    private readonly priorityV2: PriorityV2Service,
    // RPT12 reads real cross-org sharing requests. forwardRef because
    // ReportSharingModule imports ReportsModule (see reports.module.ts).
    @Inject(forwardRef(() => ReportSharingService))
    private readonly sharing: ReportSharingService,
    // RPT02's SLA compliance figure — same source the dashboard screen uses.
    private readonly sla: ReviewerSlaService,
  ) {
    super();
  }

  // A study with no scored data isn't an error condition to hide — it's a
  // state the caller can fix by running scoring. Anything else is a genuine
  // fault and must not be dressed up as an empty-but-valid report.
  private rethrow(scope: string, err: unknown): never {
    if ((err as Error).message === "no-data") {
      throw new ConflictException({
        error: {
          code: "STUDY_NOT_SCORED",
          message: "This study has no scored data yet. Run scoring before generating this report.",
        },
      });
    }
    // Detail stays server-side — it carries study/survey ids and Prisma internals.
    this.logger.error(`${scope} report generation failed: ${(err as Error).message}`);
    throw err;
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
      this.rethrow("Village", err);
    }
  }

  async getSectorReport(query: ScopedReportQuery): Promise<SectorReportContent> {
    try {
      if (!query.studyId) throw new Error("studyId required");
      const surveyId = await this.resolveSurveyId(query.studyId, query.filters);
      const domainKey = typeof query.filters.domainKey === "string" ? query.filters.domainKey : undefined;
      const { snapshot, aiOutput } = await this.realData(query.studyId, surveyId, "SECTOR", { domainKey });
      // Demographics (gender/settlement) aren't domain-scoped — same
      // study-wide (or village-scoped, if a village context was also picked)
      // aggregate as every other scope, not silently skipped.
      const villageId = typeof query.filters.villageId === "string" ? query.filters.villageId : "";
      const demographics = await aggregateDemographics(this.tenant, query.studyId, villageId);
      return snapshotToSectorContent({ snapshot, aiOutput, filters: query.filters, demographics });
    } catch (err) {
      this.rethrow("Sector", err);
    }
  }

  async getRegionReport(query: ScopedReportQuery): Promise<RegionReportContent> {
    try {
      if (!query.studyId) throw new Error("studyId required");
      const surveyId = await this.resolveSurveyId(query.studyId, query.filters);
      const regionId = typeof query.filters.regionId === "string" ? query.filters.regionId : undefined;
      const { snapshot, aiOutput } = await this.realData(query.studyId, surveyId, "REGION", { regionId });
      // TODO(multi-region): this aggregates study-wide (or the optional
      // village sub-filter), not scoped down to just this region's own
      // villages — regionId isn't resolved to a village list anywhere in
      // this pipeline yet. Still real, non-null data rather than the
      // previous hard-coded "unavailable".
      const villageId = typeof query.filters.villageId === "string" ? query.filters.villageId : "";
      const demographics = await aggregateDemographics(this.tenant, query.studyId, villageId);
      return snapshotToRegionContent({ snapshot, aiOutput, filters: query.filters, demographics });
    } catch (err) {
      this.rethrow("Region", err);
    }
  }

  async getExecutiveReport(query: ScopedReportQuery): Promise<ExecutiveReportContent> {
    try {
      if (!query.studyId) throw new Error("studyId required");
      const surveyId = await this.resolveSurveyId(query.studyId, query.filters);
      const { snapshot, aiOutput } = await this.realData(query.studyId, surveyId, "EXECUTIVE", {});
      // Consolidated across every village in the study — same "no villageId
      // filter" convention aggregateDemographics already uses.
      const demographics = await aggregateDemographics(this.tenant, query.studyId, "");
      return snapshotToExecutiveContent({ snapshot, aiOutput, filters: query.filters, demographics });
    } catch (err) {
      this.rethrow("Executive", err);
    }
  }

  // RPT02 Collective Report — the exportable form of the Collective Dashboard.
  // Reuses the same real aggregate (so the export and the screen agree) and the
  // same reviewer-SLA compliance figure. The narrative is derived from those
  // real numbers rather than generated: SummaryScopeType has no COLLECTIVE
  // scope, so a Gemini narrative here would need a new snapshot shape — a
  // factual paragraph beats an invented one in the meantime.
  async getCollectiveReport(query: ScopedReportQuery): Promise<CollectiveReportContent> {
    const [data, alerts] = await Promise.all([this.getCollectiveDashboard(query), this.sla.listAlerts()]);
    const { slaCompliancePct } = slaComplianceFromAlerts(alerts);

    return {
      header: {
        studyName: query.studyTitle ?? "Collective Community Needs Report",
        entityName: null,
        // Cross-study aggregate — no single methodology version applies.
        methodologyVersion: "Cross-study aggregate",
        reportGeneratedAt: new Date().toISOString(),
      },
      kpis: { needCount: data.needCount, slaCompliancePct },
      scoringDistribution: data.scoringDistribution,
      aiSummary: buildCollectiveNarrative(data, slaCompliancePct),
      filters: query.filters,
    };
  }

  // RPT12 Report Sharing Status — real ReportSharingRequest rows. Goes through
  // ReportSharingService rather than querying the table directly so the
  // cross-org visibility rule (superadmin sees all, otherwise owner-or-
  // requester only) stays defined in exactly one place.
  async getSharingStatus(query: ScopedReportQuery): Promise<SharingStatusContent> {
    const rows = await this.sharing.list();
    const tally = { approved: 0, pending: 0, rejected: 0 };
    for (const r of rows) {
      if (r.status === "approved") tally.approved += 1;
      else if (r.status === "rejected") tally.rejected += 1;
      else if (r.status === "pending") tally.pending += 1;
    }

    return {
      header: {
        studyName: "Report Sharing Status",
        entityName: null,
        methodologyVersion: "Cross-organisation sharing log",
        reportGeneratedAt: new Date().toISOString(),
      },
      summary: tally,
      requests: rows.map((r) => ({
        reportTitle: r.reportTitle,
        requestingOrg: r.requestingOrgName,
        ownerOrg: r.ownerOrgName,
        status: r.status,
        requestedAt: r.requestedAt,
        decidedAt: r.decidedAt,
      })),
      filters: query.filters,
    };
  }
  // Collective dashboard — REAL org-wide aggregation. Needs count + scoring
  // distribution + top priorities come from the same VillagePriorityAssessment
  // rows the Priority Dashboard reads (so the two reconcile); anomalies from
  // ResponseQualityResult flags; reviewer notes from decided AiDecisions. An
  // org with no needs yet returns real zeros (not the Sample-Village mock);
  // only an unexpected error falls back to the mock so the screen never dies.
  // The aggregate is org-wide — scoped by the tenant context, not by `query`,
  // which is why the parameter is unused (it was only read by the old fallback).
  async getCollectiveDashboard(_query: ScopedReportQuery): Promise<CollectiveDashboardData> {
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
      this.rethrow("Collective dashboard", err);
    }
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

// RPT02's narrative, stated from the real aggregate only. Every sentence is
// traceable to a number in `data` — nothing is asserted that wasn't measured.
function buildCollectiveNarrative(
  data: CollectiveDashboardData,
  slaCompliancePct: number | null,
): CollectiveReportContent["aiSummary"] {
  if (data.needCount === 0) {
    return {
      executiveSummary: "No needs have been recorded for this organisation yet.",
      keyFindings: "There is no scored data to summarise.",
      dataQualityNote: "No responses have been assessed.",
      trendNote: "Trend pending — no assessment cycle has completed.",
      recommendations: [],
    };
  }

  const high = data.scoringDistribution.find((b) => b.band === "High")?.count ?? 0;
  const scored = data.scoringDistribution.reduce((n, b) => n + b.count, 0);
  const domains = [...new Set(data.topPriorities.map((p) => p.domain))];
  const leading = domains.slice(0, 2).join(" and ");

  const executiveSummary =
    `${data.needCount} need(s) recorded, of which ${scored} are scored. ` +
    `${high} are High priority` +
    (leading ? `; the highest-severity needs fall under ${leading}.` : ".");

  const keyFindings = data.topPriorities.length
    ? data.topPriorities
        .map((p) => `${p.rank}. ${p.label} (${p.domain}, severity ${p.severityScore})`)
        .join("; ")
    : "No needs have been scored yet, so no priority ranking is available.";

  const dataQualityNote = data.anomalies.length
    ? data.anomalies.map((a) => a.note).join(" ")
    : "No response-quality anomalies were flagged.";

  const recommendations: string[] = [];
  if (domains[0]) recommendations.push(`Prioritise interventions in ${domains[0]}.`);
  if (data.anomalies.some((a) => a.severity === "warning"))
    recommendations.push("Field-validate the findings flagged as low confidence.");
  if (slaCompliancePct !== null && slaCompliancePct < 100)
    recommendations.push(`Clear the overdue reviewer queue — SLA compliance is ${slaCompliancePct}%.`);

  return {
    executiveSummary,
    keyFindings,
    dataQualityNote,
    trendNote: data.trends[0]?.note ?? "Trend pending — first assessment cycle.",
    recommendations,
  };
}
