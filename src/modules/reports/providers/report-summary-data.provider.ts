import { ConflictException, Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { TenantPrismaService } from "../../../tenancy/tenant-prisma.service";
import type {
  CollectiveDashboardData,
  CollectiveReportContent,
  CombinedReportContent,
  CoverageBlock,
  DataQualityReportContent,
  Demographics,
  ExecutiveReportContent,
  IndividualSurveyReportContent,
  RegionReportContent,
  SectorReportContent,
  SectorScopeBasis,
  SharingStatusContent,
  SurveyIdentity,
  SurveyReportBase,
  TopPriorityReportContent,
  VillageReportContent,
} from "../report-content.types";
import { currentLocale } from "../../../tenancy/org-context";
import { DEFAULT_APP_LOCALE, type AppLocale } from "../../../i18n/locale";
import { translator } from "../../../i18n/translate";
import type { UnifiedRpt01Sections } from "../unified-report.types";
import { buildDataQualityContent, buildTopPriorityContent } from "./build-focused-reports";
import { loadDataCollectionCompleteness } from "./load-data-collection-completeness";
import { SurveySessionsService } from "../../survey-sessions/survey-sessions.service";
import {
  ReportSummaryService,
  type ReportDataSnapshot,
  type ScopeFilters,
  type SummaryScopeType,
} from "../report-summary.service";
import { PriorityV2Service } from "../../priority/priority-v2.service";
import { ReportSharingService } from "../../report-sharing/report-sharing.service";
import { ReviewerSlaService } from "../../reviewer-sla/reviewer-sla.service";
import { NeedSummaryService } from '../../needs/need-summary.service';
import { slaComplianceFromAlerts } from "../../reviewer-sla/sla-compliance";
import { aggregateDemographics } from "./aggregate-demographics";
import { loadRegionBreakdown } from "./load-region-breakdown";
import { loadSectorScopeBasis } from "./load-sector-scope-basis";
import {
  ReportDataProvider,
  type ScopedReportQuery,
  type SurveyReportQuery,
  type VillageReportQuery,
} from "./report-data.provider";
import {
  snapshotToCombinedContent,
  snapshotToExecutiveContent,
  snapshotToRegionContent,
  snapshotToSectorContent,
  snapshotToSurveyBase,
  snapshotToVillageContent,
} from "./snapshot-to-content";
import { buildCoverageBlock } from "./coverage-counts";
import { buildPortfolioBlock } from "./portfolio-counts";
import { assertRpt01SelfConsistent } from "./assert-rpt01-self-consistent";
import {
  buildUnifiedRpt01,
  composeDeterministicNarrative,
  type UnifiedRpt01Input,
} from "./build-unified-rpt01";
import { loadRpt01ReferenceData, type Rpt01ReferenceData } from "./load-rpt01-inputs";
import { loadSegmentSeverities } from "./load-segment-severities";
import type { DomainMeta, RollupLevelValue } from "./build-need-hierarchy";
import type { SegmentRow } from "./derive-equity-flag";
import { DEFAULT_THRESHOLDS, type ConfidenceFlag, type UnitGeo } from "../need-record.types";

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
    // RPT10's abandonment figures. Reads the session rows the citizen flow
    // writes; see load-data-collection-completeness.ts.
    private readonly sessions: SurveySessionsService,
    // RIO-AI-003 — a Need whose long description has a CONFIRMED summary shows
    // that summary here instead of the raw statement. See the call site below.
    private readonly needSummaries: NeedSummaryService,
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
      const demographics = await aggregateDemographics(this.tenant, { studyId: query.studyId }, query.villageId);
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

  // RPT01 Individual Survey Report. Scoped to the caller's named survey — never
  // resolveSurveyId's "most recent survey in the study" guess, which is fine for
  // a study-wide aggregate but would silently report on the wrong survey here.
  async getIndividualSurveyReport(query: SurveyReportQuery): Promise<IndividualSurveyReportContent> {
    try {
      const { base, unified, aiSummary } = await this.unifiedHalf(query, "INDIVIDUAL");

      // Coverage counts and the sections beneath them must agree — the tiles
      // once said 4 domains over a table of 2. Assert it here so an inconsistent
      // report cannot be persisted, rather than at the client's desk.
      const content: IndividualSurveyReportContent = { ...base, aiSummary, ...unified };
      assertRpt01SelfConsistent(content);
      return content;
    } catch (err) {
      this.rethrow("Individual survey", err);
    }
  }

  /**
   * The unified-pipeline half: one snapshot → one set of need records → the six
   * narrative sections. RPT01, RPT03/09 and RPT10 all consume exactly this, and
   * that shared call is the reconciliation guarantee — the same one RPT15 gets
   * from sharing surveyHalf(). Recomputing any of it per report type is what
   * would let the three drift apart.
   */
  private async unifiedHalf(
    query: SurveyReportQuery,
    scope: SummaryScopeType,
  ): Promise<{
    snapshot: ReportDataSnapshot;
    base: SurveyReportBase;
    unified: UnifiedRpt01Sections;
    aiSummary: SurveyReportBase["aiSummary"];
    demographics: Demographics | null;
  }> {
    const half = await this.surveyHalf(query, scope);
    const { snapshot, aiOutput, survey, coverage, demographics } = half;

    const base = snapshotToSurveyBase({
      snapshot,
      aiOutput,
      survey,
      coverage,
      demographics,
      assessmentPeriod: coverage.assessmentPeriod,
      filters: query.filters,
    });

    const villageId = typeof query.filters.villageId === "string" ? query.filters.villageId : "";
    const [reference, segmentsByIndicator] = await Promise.all([
      loadRpt01ReferenceData(this.tenant, {
        studyId: query.studyId,
        surveyId: query.surveyId,
        methodologyVersionId: snapshot.study.methodologyVersionId,
        villageId: villageId || undefined,
      }),
      loadSegmentSeverities(this.tenant, {
        studyId: query.studyId,
        surveyId: query.surveyId,
        methodologyVersionId: snapshot.study.methodologyVersionId,
        villageId: villageId || undefined,
      }),
    ]);
    // The SAME geography the AI snapshot was written against — resolving it a
    // second time here is exactly how the header and the narrative came to
    // name different governorates.
    const unitGeo = snapshot.unitGeo ?? EMPTY_UNIT_GEO;

    const unified = buildUnifiedRpt01(
      assembleUnifiedInput({ snapshot, coverage, base, reference, segmentsByIndicator, unitGeo, villageId }),
    );

    // No narrative (AI unavailable, or its cached output was written against a
    // superseded prompt and was rejected above) → compose one from the figures
    // rather than ship an empty summary or a stale, contradicting one.
    // Composed in the caller's own language. This is the narrative an Arabic
    // report falls back to whenever the model is unavailable or its cached
    // output was rejected — so leaving it English would put a paragraph of
    // English in the most visible part of an otherwise-Arabic report, in
    // exactly the situation where nothing else can fix it.
    const fallback = composeDeterministicNarrative(unified, currentLocale());
    const aiSummary = {
      ...base.aiSummary,
      executiveSummary: base.aiSummary.executiveSummary || fallback.executiveSummary,
      keyFindings: base.aiSummary.keyFindings || fallback.keyFindings,
    };

    return { snapshot, base, unified, aiSummary, demographics };
  }

  // RPT03 / RPT09 Top-Priority Report. Study-scoped: follows the same
  // resolveSurveyId convention as the sector/region/executive reports rather
  // than requiring the caller to name a survey, since "the study's highest
  // priorities" is a study-level question.
  async getTopPriorityReport(query: ScopedReportQuery): Promise<TopPriorityReportContent> {
    try {
      if (!query.studyId) throw new Error("studyId required");
      const surveyId = await this.resolveSurveyId(query.studyId, query.filters);
      const { snapshot, base, unified, aiSummary, demographics } = await this.unifiedHalf(
        { ...query, studyId: query.studyId, surveyId },
        "EXECUTIVE",
      );

      return buildTopPriorityContent({
        header: base.header,
        unified,
        responseQuality: base.responseQuality,
        aiSummary,
        dataQualityNote: base.dataQualityNote,
        trendNote: base.trendNote,
        demographics,
        domains: base.severity.domains,
        scope: {
          villages: snapshot.study.villageName || "Consolidated Villages",
          governorate: snapshot.study.governorateName,
        },
        filters: query.filters,
      });
    } catch (err) {
      this.rethrow("Top-priority", err);
    }
  }

  // RPT10 Data-Quality Report. Same unified half, projected onto completeness
  // and confidence instead of ranking — so the quality figures a reader sees
  // here are the ones that produced the scores in every other report.
  async getDataQualityReport(query: ScopedReportQuery): Promise<DataQualityReportContent> {
    try {
      if (!query.studyId) throw new Error("studyId required");
      // Whether the CALLER named a survey is the scope decision, and it has to
      // be read before resolveSurveyId erases the distinction by picking one.
      // RPT10 was labelled study-scoped while silently reporting on a single
      // resolved survey; the completeness block now states which it is and
      // names the surveys it does not cover.
      const explicitSurvey = typeof query.filters.surveyId === "string" && query.filters.surveyId.length > 0;
      const surveyId = await this.resolveSurveyId(query.studyId, query.filters);
      // `demographics` is aggregated by the same half RPT01/RPT09 use, so the
      // breakdown here is the one those reports show - it was being computed
      // and then dropped on the floor, which is why RPT10 rendered a permanent
      // "demographic capture is pending" placeholder over real captured data.
      const { base, unified, aiSummary, demographics } = await this.unifiedHalf(
        { ...query, studyId: query.studyId, surveyId },
        "EXECUTIVE",
      );

      // Scope the breakdown to whatever this report claims to cover. The shared
      // half aggregates by the RESOLVED survey's Need - right for RPT01, wrong
      // here whenever the caller named no survey, since the completeness block
      // above then reports on every survey in the study. A gender split drawn
      // from one of them under a study-wide heading is the same scope leak the
      // Need-scoping was introduced to stop, pointing the other way.
      const villageId = typeof query.filters.villageId === "string" ? query.filters.villageId : "";
      const scopedDemographics = explicitSurvey
        ? demographics
        : await aggregateDemographics(this.tenant, { studyId: query.studyId }, villageId);

      const dataCollection = await loadDataCollectionCompleteness(this.tenant, this.sessions, {
        studyId: query.studyId,
        resolvedSurveyId: surveyId,
        explicitSurvey,
        // The rollup is the authority on submitted-response exclusion, here as
        // everywhere else — this figure is passed through, never recomputed.
        excludedSubmitted: unified.dataQualityNotes.responseQuality.excluded,
      });

      return buildDataQualityContent({
        header: base.header,
        unified,
        responseQuality: base.responseQuality,
        aiSummary,
        dataQualityNote: base.dataQualityNote,
        trendNote: base.trendNote,
        domains: base.severity.domains,
        dataCollection,
        demographics: scopedDemographics,
        filters: query.filters,
      });
    } catch (err) {
      this.rethrow("Data-quality", err);
    }
  }

  // RPT15 Survey & Dashboard Report.
  //
  // Reconciliation: the survey half comes from ONE surveyHalf() call (the same
  // one getIndividualSurveyReport makes) and the dashboard half from ONE
  // getCollectiveDashboard() + ONE listAlerts() call. Nothing is computed twice,
  // which is what stops the two halves drifting apart. See the reconciliation
  // spec — it asserts this equality directly.
  async getCombinedReport(query: SurveyReportQuery): Promise<CombinedReportContent> {
    try {
      const [half, dashboard, alerts] = await Promise.all([
        this.surveyHalf(query, "COMBINED"),
        this.getCollectiveDashboard({ studyId: query.studyId, orgId: query.orgId, filters: query.filters }),
        this.sla.listAlerts(),
      ]);
      const { slaCompliancePct, breached, atRisk } = slaComplianceFromAlerts(alerts);
      const portfolio = await buildPortfolioBlock(this.tenant, half.coverage.responsesSubmitted);

      return snapshotToCombinedContent({
        snapshot: half.snapshot,
        aiOutput: half.aiOutput,
        survey: half.survey,
        coverage: half.coverage,
        demographics: half.demographics,
        assessmentPeriod: half.coverage.assessmentPeriod,
        portfolio,
        dashboard,
        sla: { slaCompliancePct, breached, atRisk },
        // The survey half is frozen at snapshot time; this half is live. Both
        // stamps are rendered so a reader knows what each is as-of.
        dashboardCapturedAt: new Date().toISOString(),
        filters: query.filters,
      });
    } catch (err) {
      this.rethrow("Combined survey + dashboard", err);
    }
  }

  // The shared survey half of RPT01 and RPT15 — one snapshot, one AI narrative,
  // one coverage-count pass, one demographics aggregate. Both reports consume
  // exactly this, which is what makes them reconcile by construction.
  private async surveyHalf(
    query: SurveyReportQuery,
    scope: SummaryScopeType,
  ): Promise<{
    snapshot: ReportDataSnapshot;
    aiOutput: Record<string, unknown> | null;
    survey: SurveyIdentity;
    coverage: CoverageBlock;
    demographics: Demographics | null;
    needId: string;
  }> {
    const villageId = typeof query.filters.villageId === "string" ? query.filters.villageId : "";

    const survey = await this.tenant.runInOrgContext((tx) =>
      tx.survey.findUnique({
        where: { id: query.surveyId },
        include: { need: { select: { statement: true, status: true, village: true } } },
      }),
    );
    if (!survey) throw new Error(`survey ${query.surveyId} not found`);

    const { snapshot, aiOutput } = await this.realData(query.studyId, query.surveyId, scope, { villageId });

    const coverage = await buildCoverageBlock(this.tenant, {
      studyId: query.studyId,
      surveyId: query.surveyId,
      needId: survey.needId,
      villageId: villageId || undefined,
      validResponseCount: snapshot.responseQuality.validResponseCount,
      // The snapshot reports valid + submitted; excluded is the difference. The
      // rollup is the authority on both, so this can't disagree with severity.
      excludedResponseCount: Math.max(
        0,
        snapshot.responseQuality.submittedResponseCount - snapshot.responseQuality.validResponseCount,
      ),
      // Snapshot carries the rate as a 0-1 fraction; the report shows a percent.
      dontKnowRatePct: Math.round(snapshot.responseQuality.dontKnowRate * 100),
      assessmentPeriod: query.assessmentPeriod,
    });

    // Scoped to the Survey's own Need. A study-wide filter pulled sibling
    // surveys' respondents into this survey's gender breakdown.
    const demographics = await aggregateDemographics(this.tenant, { needId: survey.needId }, villageId);

    // RIO-AI-003. `needStatement` renders as one row in the report's Survey
    // key-value band, beside values like "Published" and "Cycle 1" — a 5,000
    // character statement there breaks the PDF layout and produces an
    // unreadable Excel cell. A reviewer-CONFIRMED summary replaces it.
    //
    // Falls back to the raw statement, deliberately: most needs are short
    // enough never to be summarised, and a draft nobody has confirmed must
    // never reach a published report (getConfirmedTextForNeed returns null for
    // DRAFT/STALE/SUPERSEDED rows, which is what makes that gate real).
    const confirmedSummary = await this.needSummaries.getConfirmedTextForNeed(survey.needId);

    const identity: SurveyIdentity = {
      surveyId: survey.id,
      surveyTitle: survey.title,
      surveyStatus: survey.status,
      needStatement: confirmedSummary ?? survey.need.statement,
      needStatus: survey.need.status,
      villageName: snapshot.study.villageName,
      assessmentCycle: snapshot.study.assessmentCycle,
      assessmentPeriod: coverage.assessmentPeriod,
      methodologyVersion: survey.methodologyVersion,
      publishedAt: survey.publishedAt ? survey.publishedAt.toISOString() : null,
    };

    return { snapshot, aiOutput, survey: identity, coverage, demographics, needId: survey.needId };
  }

  async getSectorReport(query: ScopedReportQuery): Promise<SectorReportContent> {
    try {
      if (!query.studyId) throw new Error("studyId required");
      const surveyId = await this.resolveSurveyId(query.studyId, query.filters);
      const domainKey = typeof query.filters.domainKey === "string" ? query.filters.domainKey : undefined;
      const scopeBasis = await this.sectorScopeBasis(query.studyId, surveyId, query.filters);
      const { snapshot, aiOutput } = await this.realData(query.studyId, surveyId, "SECTOR", { domainKey });
      // Demographics (gender/settlement) aren't domain-scoped — same
      // study-wide (or village-scoped, if a village context was also picked)
      // aggregate as every other scope, not silently skipped.
      const villageId = typeof query.filters.villageId === "string" ? query.filters.villageId : "";
      const demographics = await aggregateDemographics(this.tenant, { studyId: query.studyId }, villageId);
      return snapshotToSectorContent({ snapshot, aiOutput, filters: query.filters, demographics, scopeBasis });
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

      // Region-SCOPED, not study-wide: the region is resolved to its own
      // governorates and their villages, and each governorate's figures come
      // from its own villages' rollups. Reading the study-wide rollup and
      // printing it under a region's name meant two regions in one study
      // reported identical numbers.
      const breakdown = await loadRegionBreakdown(this.tenant, {
        studyId: query.studyId,
        surveyId,
        methodologyVersionId: snapshot.study.methodologyVersionId,
        regionId,
      });

      // Demographics follow the same scope: the villages this region actually
      // covers, so the gender split belongs to the rows above it. A region with
      // no resolved villages falls back to study-wide rather than reporting an
      // empty breakdown as though nobody answered.
      const villageId = typeof query.filters.villageId === "string" ? query.filters.villageId : "";
      const villageNames = breakdown.villages.map((v) => v.village);
      const demographics = await aggregateDemographics(
        this.tenant,
        { studyId: query.studyId },
        villageId,
        villageNames.length ? villageNames : undefined,
      );

      return snapshotToRegionContent({ snapshot, aiOutput, breakdown, filters: query.filters, demographics });
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
      const demographics = await aggregateDemographics(this.tenant, { studyId: query.studyId }, "");
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
      aiSummary: buildCollectiveNarrative(data, slaCompliancePct, currentLocale()),
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
    // RIO-FR-011: with survey versioning, `createdAt desc` alone can resolve
    // to a DRAFT version created after the published one — a draft has no
    // data to report on. PUBLISHED first (there's at most one at a time —
    // see SurveysService.approveAndPublish's supersede step), falling back
    // to the newest of whatever exists for a study that's never been
    // published at all.
    const survey =
      (await this.tenant.runInOrgContext((tx) =>
        tx.survey.findFirst({ where: { studyId, status: "PUBLISHED" }, orderBy: { createdAt: "desc" } }),
      )) ??
      (await this.tenant.runInOrgContext((tx) =>
        tx.survey.findFirst({ where: { studyId }, orderBy: { createdAt: "desc" } }),
      ));
    if (!survey) throw new Error(`no survey for study ${studyId}`);
    return survey.id;
  }

  /** See loadSectorScopeBasis — shared with the Insights save path. */
  private sectorScopeBasis(
    studyId: string,
    surveyId: string,
    filters: Record<string, unknown>,
  ): Promise<SectorScopeBasis> {
    return loadSectorScopeBasis(this.tenant, {
      studyId,
      surveyId,
      explicitSurveyFilter: typeof filters.surveyId === "string" && filters.surveyId.length > 0,
    });
  }

  // Reuse an existing AI summary; otherwise build the snapshot and (best-effort)
  // generate one. Throws "no-data" when the study has no scores yet → fallback.
  private async realData(
    studyId: string,
    surveyId: string,
    scope: SummaryScopeType,
    scopeFilters: ScopeFilters,
  ): Promise<{ snapshot: ReportDataSnapshot; aiOutput: Record<string, unknown> | null }> {
    // The WHOLE filter set, not just the village: a SECTOR report filtered to
    // one domain and an unfiltered one are different reports, and passing only
    // villageId made them share a cached summary and snapshot.
    const existing = await this.summary.getSummary(studyId, surveyId, scope, scopeFilters);
    // A summary written by an OLDER prompt is not reusable. The 28 Jul narrative
    // repeated a canned "high rate of Don't Know" premise that the snapshot no
    // longer supplies; reusing it would keep printing the corrected report with
    // the uncorrected sentence on top. Regenerate when the prompt has moved on.
    // A summary is reusable only when BOTH the prompt and the data it was
    // written against are still current. `snapshotId` is a content hash, so a
    // corrected figure — or a corrected place name — changes it and forces a
    // regeneration instead of printing last week's sentence over this week's
    // numbers.
    const s = existing?.summary as
      | { promptVersion?: string; reportDataSnapshotId?: string; outputLanguage?: string | null }
      | undefined;
    // Language is a reuse condition, not a display detail. Serving a stored
    // English narrative to an Arabic reader is the same class of bug as serving
    // a stale one: the text is fine, it just is not the text this request asked
    // for — and no amount of correct prompting fixes it, because the model is
    // never called (RIO-I18N-003 §9.2).
    //
    // A row with no recorded language predates the column. It is reusable only
    // for English, which is what it will be: every narrative written before
    // this shipped was generated by a prompt that named no language, and those
    // answered in English.
    const wanted = currentLocale();
    const languageMatches = (s?.outputLanguage ?? DEFAULT_APP_LOCALE) === wanted;
    const reusable =
      existing !== null &&
      s?.promptVersion === this.summary.promptVersionFor(scope) &&
      s?.reportDataSnapshotId === existing.snapshot.snapshotId &&
      languageMatches;
    if (existing && reusable && this.hasData(existing.snapshot)) {
      const out = existing.summary as { officerEditedOutputJson?: unknown; aiOutputJson?: unknown };
      return {
        snapshot: existing.snapshot,
        aiOutput: (out.officerEditedOutputJson ?? out.aiOutputJson ?? null) as Record<string, unknown> | null,
      };
    }

    const { snapshot } = await this.summary.buildReportDataSnapshot(studyId, surveyId, scope, scopeFilters);
    if (!this.hasData(snapshot)) throw new Error("no-data");

    // Real data exists but no saved summary — generate one (reuse-then-generate).
    // If AI is unavailable (e.g. no GEMINI key), still return the real snapshot.
    let aiOutput: Record<string, unknown> | null = null;
    try {
      const gen = await this.summary.generatePrioritySummary(
        studyId,
        surveyId,
        scope,
        scopeFilters,
        undefined,
        wanted,
      );
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

// Shown when a Need has no geography linked at all. Every field is honestly
// empty rather than a plausible-looking default.
const EMPTY_UNIT_GEO: UnitGeo = {
  regionId: null,
  regionName: null,
  governorateIds: [],
  governorateNames: [],
  centerIds: [],
  centerNames: [],
  villages: [],
  scopeLabel: "No governorate or village is linked to this need.",
};

// Marshals the scoring snapshot + reference data into the pure builder's input.
// Deliberately does no arithmetic of its own — every derived figure is computed
// inside buildUnifiedRpt01, which is unit-testable without a database.
function assembleUnifiedInput(input: {
  snapshot: ReportDataSnapshot;
  coverage: CoverageBlock;
  base: SurveyReportBase;
  reference: Rpt01ReferenceData;
  segmentsByIndicator: Map<string, SegmentRow[]>;
  unitGeo: UnitGeo;
  villageId: string;
}): UnifiedRpt01Input {
  const { snapshot, coverage, base, reference, segmentsByIndicator, unitGeo, villageId } = input;
  const sev = snapshot.severity;

  const toLevel = (r: { severityScore: number | null; confidenceLevel: string }): RollupLevelValue => ({
    severityScore: r.severityScore,
    confidence: r.confidenceLevel.toUpperCase() === "LOW" ? "LOW" : "STANDARD",
  });

  const domainMetaByKey = new Map<string, DomainMeta>();
  for (const d of base.severity.domains) {
    domainMetaByKey.set(d.domainCode, {
      domain: d.name,
      domainKey: d.domainCode,
      severityScore: d.severityScore,
      performanceScore: d.performanceScore,
      weight: d.weight,
      weightedContribution: d.weightedContribution,
      confidence: d.confidence,
      confidenceReason: d.confidenceReason,
      isCriticalDomain: d.isCriticalDomain,
      kpisDefined: reference.kpisDefinedByDomainKey.get(d.domainCode) ?? d.kpiCount,
      questionsAsked: reference.questionsAskedByDomainKey.get(d.domainCode) ?? 0,
      // Cycle-over-cycle comparison needs prior-cycle rollups, which are not
      // stored per cycle today. Left null so the trend note says exactly that
      // instead of implying a comparison was made.
      priorCycleSeverity: null,
    });
  }

  const assessedWeights = base.severity.domains
    .map((d) => reference.domainWeightByKey.get(d.domainCode) ?? null)
    .filter((w): w is number => w !== null);

  return {
    generatedAt: snapshot.generatedAt,
    surveyId: snapshot.study.surveyId,
    surveyTitle: base.survey.surveyTitle,
    studyId: snapshot.study.studyId,
    snapshotId: snapshot.snapshotId,
    methodologyVersionId: snapshot.study.methodologyVersionId,
    methodologyVersionLabel: snapshot.study.methodologyVersionLabel ?? snapshot.study.methodologyVersionId,
    assessmentCycle: snapshot.study.assessmentCycle,
    calculatedAt: snapshot.priority.calculatedAt,
    villageScope: villageId || "",
    unitGeo,
    sourceNeedAffectedPopulation: reference.sourceNeedAffectedPopulation,

    kpiRollups: sev.kpiSeverityScores.map((k) => ({
      entityId: k.entityId,
      entityNameSnapshot: k.entityName,
      severityScore: k.severityScore,
      confidenceLevel: k.confidenceLevel,
      validResponseCount: k.validResponseCount,
      excludedResponseCount: k.excludedResponseCount,
      dontKnowCount: k.dontKnowCount,
      notApplicableCount: k.notApplicableCount,
      dontKnowRate: k.dontKnowRate,
    })),
    classificationByIndicator: reference.classificationByIndicator,
    segmentsByIndicator,
    // No prior-cycle rollups are stored, so `chronic` cannot be established and
    // is never claimed. See the gap-type precedence note.
    priorCycleByIndicator: new Map<string, number>(),
    subDomainByKey: new Map(sev.subDomainSeverityScores.map((r) => [r.entityId, toLevel(r)])),
    indicatorByKey: new Map(sev.indicatorSeverityScores.map((r) => [r.entityId, toLevel(r)])),
    domainMetaByKey,
    allDomains: reference.allDomains,
    domainWeightByKey: reference.domainWeightByKey,

    overallNeedsIndex: sev.overallVillageNeedsIndex,
    overallConfidence: base.responseQuality.overallConfidence as ConfidenceFlag,
    overallConfidenceReason: base.responseQuality.confidenceReason,
    priorCycleOverallSeverity: null,

    responseQuality: {
      submitted: coverage.responsesSubmitted,
      valid: coverage.responsesValid,
      excluded: coverage.responsesExcluded,
      dontKnowRate: snapshot.responseQuality.dontKnowRate,
      duplicatesFlagged: coverage.duplicateResponses,
      lowConfidenceFlagged: coverage.lowConfidenceResponses,
    },
    dontKnowRateByDomain: sev.domainSeverityScores.map((d) => ({
      domain: d.domainName,
      rate: d.dontKnowRate,
    })),
    exclusionBreakdown: reference.exclusionBreakdown,
    totalAnswers: reference.totalAnswers,

    villagePriority: {
      priorityScore: snapshot.priority.villagePriorityScore,
      overrideApplied: snapshot.priority.overrideApplied,
      overrideReason: snapshot.priority.overrideReason,
      assessedWeightSum: assessedWeights.length
        ? assessedWeights.reduce((a, b) => a + b, 0)
        : null,
    },

    thresholds: DEFAULT_THRESHOLDS,
  };
}

// RPT02's narrative, stated from the real aggregate only. Every sentence is
// traceable to a number in `data` — nothing is asserted that wasn't measured.
/**
 * RPT02's narrative, composed from figures rather than by the model.
 *
 * Written in the caller's language (RIO-I18N-003 §6). Domain and need names
 * inside it stay in whatever language the reference data holds — the sentence
 * around them is translated, the names are not invented here.
 */
function buildCollectiveNarrative(
  data: CollectiveDashboardData,
  slaCompliancePct: number | null,
  locale: AppLocale = DEFAULT_APP_LOCALE,
): CollectiveReportContent["aiSummary"] {
  const t = translator(locale);

  if (data.needCount === 0) {
    return {
      executiveSummary: t("narrative.coll.noNeeds"),
      keyFindings: t("narrative.coll.noScoredData"),
      dataQualityNote: t("narrative.coll.noResponsesAssessed"),
      trendNote: t("narrative.coll.trendNoCycle"),
      recommendations: [],
    };
  }

  const high = data.scoringDistribution.find((b) => b.band === "High")?.count ?? 0;
  const scored = data.scoringDistribution.reduce((n, b) => n + b.count, 0);
  const domains = [...new Set(data.topPriorities.map((p) => p.domain))];
  const leading = domains.slice(0, 2).join(" / ");

  const executiveSummary =
    `${t("narrative.coll.recorded", { needs: data.needCount, scored })} ` +
    t("narrative.coll.highPriority", { high }) +
    (leading ? t("narrative.coll.leadingDomains", { domains: leading }) : ".");

  const keyFindings = data.topPriorities.length
    ? data.topPriorities
        .map((p) =>
          t("narrative.coll.finding", {
            rank: p.rank,
            label: p.label,
            domain: p.domain,
            score: p.severityScore,
          }),
        )
        .join("; ")
    : t("narrative.coll.noRanking");

  const dataQualityNote = data.anomalies.length
    ? // Anomaly notes are composed elsewhere and are not translated here — doing
      // so would mean re-deriving them, and they are the reason a figure is
      // flagged, so paraphrasing them is not safe.
      data.anomalies.map((a) => a.note).join(" ")
    : t("narrative.coll.noAnomalies");

  const recommendations: string[] = [];
  if (domains[0]) recommendations.push(t("narrative.coll.recPrioritise", { domain: domains[0] }));
  if (data.anomalies.some((a) => a.severity === "warning"))
    recommendations.push(t("narrative.coll.recFieldValidate"));
  if (slaCompliancePct !== null && slaCompliancePct < 100)
    recommendations.push(t("narrative.coll.recClearQueue", { pct: slaCompliancePct }));

  return {
    executiveSummary,
    keyFindings,
    dataQualityNote,
    trendNote: data.trends[0]?.note ?? t("narrative.trendPendingFirstCycle"),
    recommendations,
  };
}
