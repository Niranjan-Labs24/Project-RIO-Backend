// Pure mappers: Ayush's real `ReportDataSnapshot` (+ the Gemini `aiOutputJson`)
// → our report content shapes. No DB / AI / I/O here — this is the seam where
// the real data is reshaped into what the generators, PDF/Excel export, and the
// on-screen viewer already consume. Kept pure so it is unit-testable and the
// real provider (ReportSummaryDataProvider) stays a thin orchestrator.

import type { ReportDataSnapshot } from "../report-summary.service";
import {
  DATA_QUALITY_NOTE_UNAVAILABLE,
  SINGLE_CYCLE_TREND_NOTE,
  type AiSummaryBlock,
  type ApprovalBlock,
  type CollectiveDashboardData,
  type CombinedReportContent,
  type ConfidenceLevel,
  type CoverageBlock,
  type Demographics,
  type DomainComponent,
  type ExecutiveReportContent,
  type PortfolioBlock,
  type PriorityStatus,
  type RegionReportContent,
  type ReportHeader,
  type ResponseQuality,
  type SectorReportContent,
  type SurveyIdentity,
  type SurveyReportBase,
  type TopKpi,
  type VillageReportContent,
} from "../report-content.types";
import {
  buildComparisonBand,
  buildQuestionCoverage,
  buildResponseFunnel,
} from "./survey-report-derivations";
import { composeConfidenceReason, dontKnowBandOf, priorityStatusOf } from "./severity-bands";
import { DEFAULT_THRESHOLDS } from "../need-record.types";
import { deriveTrendNote } from "./derive-trend-note";
import type { RegionBreakdown } from "./load-region-breakdown";

export const EMPTY_APPROVAL: ApprovalBlock = {
  officerConfirmedBy: null,
  officerConfirmedAt: null,
  reviewerApprovedBy: null,
  reviewerApprovedAt: null,
};

/** Snapshot confidence strings ("LOW"/"STANDARD"/…) → our banding. */
function normConfidence(v: string | null | undefined): ConfidenceLevel {
  return String(v ?? "").toUpperCase() === "LOW" ? "LOW" : "STANDARD";
}

interface MapperInput {
  snapshot: ReportDataSnapshot;
  aiOutput?: Record<string, unknown> | null;
  // Resolved by the provider (survey-response window) — not in the snapshot.
  assessmentPeriod?: string;
  // A human methodology label; snapshot only carries the version id.
  methodologyVersion?: string;
  // Overlaid from the Report row by the provider/service.
  approval?: ApprovalBlock;
  // Real gender/rural breakdown the provider aggregates from survey responses
  // (null when demographics weren't captured → "Not available").
  demographics?: Demographics | null;
  filters?: Record<string, unknown>;
}

function buildHeader(snapshot: ReportDataSnapshot, methodologyVersion?: string): ReportHeader {
  return {
    studyName: snapshot.study.studyName,
    entityName: snapshot.study.organizationName ?? null,
    methodologyVersion:
      methodologyVersion ?? snapshot.study.methodologyVersionLabel ?? snapshot.study.methodologyVersionId,
    reportGeneratedAt: snapshot.generatedAt,
  };
}

function mapResponseQuality(snapshot: ReportDataSnapshot): ResponseQuality {
  const rq = snapshot.responseQuality;
  const submitted = rq.submittedResponseCount;
  return {
    submittedResponses: submitted,
    validResponses: rq.validResponseCount,
    overallConfidence: normConfidence(rq.confidenceLevel),
    // Three distinct fields, deliberately. Folding the band and the ratio into
    // one string ("STANDARD (90%)") read as "90% confident", which is not what
    // either number means — and the reason was a canned sentence that asserted
    // a high don't-know rate whenever the band was LOW.
    confidenceReason: rq.confidenceReason,
    // Data completeness. No submissions → 100 (nothing was dropped).
    validResponseRatePct: submitted > 0 ? Math.round((rq.validResponseCount / submitted) * 100) : 100,
    dontKnowRate: rq.dontKnowRate,
    dontKnowBand: dontKnowBandOf(rq.dontKnowRate),
    population: snapshot.study.population,
    requiredSampleSize: snapshot.study.requiredSampleSize,
    minimumDetectableEffect: snapshot.study.minimumDetectableEffect,
  };
}

type DomainSeverityScore = ReportDataSnapshot["severity"]["domainSeverityScores"][number];

// Valid-response ratio (valid / submitted × 100), rounded. submitted = valid +
// excluded. No responses at all → 100 (nothing was dropped) rather than a
// misleading 0. This is data completeness, NOT a confidence percentage.
function validResponseRatioPct(ds: DomainSeverityScore | undefined): number {
  if (!ds) return 100;
  const submitted = ds.validResponseCount + ds.excludedResponseCount;
  return submitted > 0 ? Math.round((ds.validResponseCount / submitted) * 100) : 100;
}

// Per-domain confidence reason, from the same rule the flag itself uses. A
// domain flagged LOW on sample size no longer claims a high don't-know rate.
function domainConfidenceReason(ds: DomainSeverityScore | undefined): string {
  if (!ds) return "";
  return composeConfidenceReason({
    validResponseCount: ds.validResponseCount,
    dontKnowRate: ds.dontKnowRate,
    thresholds: DEFAULT_THRESHOLDS,
  });
}

// Domains carry both severity (from severity.domainSeverityScores) and the
// priority-scoring detail (from priority.domainPerformanceScores). The latter
// already matches DomainComponent 1:1; we join the former for confidence,
// confidence %, KPI count and the domain code.
function mapDomains(snapshot: ReportDataSnapshot): DomainComponent[] {
  const byKey = new Map(snapshot.severity.domainSeverityScores.map((d) => [d.domainKey, d]));
  const perf = snapshot.priority.domainPerformanceScores;
  const cycle = snapshot.study.assessmentCycle;

  // Cycle-aware. The old blanket SINGLE_CYCLE_TREND_NOTE asserted "trends cannot
  // be assessed from a single assessment cycle" on a Cycle 2 report, directly
  // contradicting its own header.
  const trendFor = (severity: number | null): string =>
    deriveTrendNote({
      assessmentCycle: cycle,
      currentSeverity: severity,
      // Prior-cycle rollups are not stored per cycle yet; the note says so
      // rather than implying a comparison was made.
      priorCycleSeverity: null,
      scopeLabel: "this domain",
    });

  if (perf.length > 0) {
    return perf.map((dp) => {
      const ds = byKey.get(dp.domainKey);
      const confidence = normConfidence(ds?.confidenceLevel);
      // The performance-score block carries its own severity copy; prefer the
      // severity rollup, which is the authority on "not measured".
      const severityScore = ds ? ds.severityScore : dp.severityScore;
      const base: DomainComponent = {
        name: dp.domainName,
        domainCode: dp.domainKey,
        severityScore,
        performanceScore: dp.performanceScore,
        weight: dp.weight,
        weightedContribution: dp.weightedContribution,
        confidence,
        confidenceReason: domainConfidenceReason(ds),
        validResponseRatePct: validResponseRatioPct(ds),
        kpiCount: ds?.kpiCount ?? 0,
        trendNote: trendFor(severityScore),
        isCriticalDomain: dp.isCriticalDomain,
      };
      // Low-confidence domains surface their sample size (drives the data-quality note).
      return confidence === "LOW" && ds ? { ...base, validResponseCount: ds.validResponseCount } : base;
    });
  }

  // Sector/severity-only fallback: no performance scores available.
  return snapshot.severity.domainSeverityScores.map((ds) => {
    const confidence = normConfidence(ds.confidenceLevel);
    const base: DomainComponent = {
      name: ds.domainName,
      domainCode: ds.domainKey,
      // No `?? 0`: an unmeasured domain stays null and renders "—".
      severityScore: ds.severityScore,
      // Null, not 0 — no priority assessment exists in this fallback, and a 0
      // performance score is a real and very bad result.
      performanceScore: null,
      weight: null,
      weightedContribution: null,
      confidence,
      confidenceReason: domainConfidenceReason(ds),
      validResponseRatePct: validResponseRatioPct(ds),
      kpiCount: ds.kpiCount,
      trendNote: trendFor(ds.severityScore),
      isCriticalDomain: false,
    };
    return confidence === "LOW" ? { ...base, validResponseCount: ds.validResponseCount } : base;
  });
}

function mapTopKpis(snapshot: ReportDataSnapshot): TopKpi[] {
  return snapshot.severity.topKpis.map((k) => ({
    rank: k.rank,
    kpi: k.kpiName,
    domain: k.domainName,
    // No `?? 0`: an unmeasured KPI shown as 0 sorted to the bottom of the
    // severity table as though it were the mildest finding.
    severityScore: k.severityScore,
    confidence: normConfidence(k.confidenceLevel),
    validResponseCount: k.validResponseCount,
    notMeasuredReason:
      k.severityScore === null
        ? `Not measured — ${k.validResponseCount} valid response(s) could be scored for this KPI.`
        : null,
  }));
}

/**
 * Promote the Data Quality and Trend notes out of the AI summary into
 * first-class report fields, applying placeholders so every report carries both
 * consistently (never blank). Returns the aiSummary with its note copies blanked
 * (so renderers don't show them twice) plus the two promoted values.
 */
export function promoteNotes(
  ai: AiSummaryBlock,
  /** Deterministic, cycle-aware fallback. Callers that know the assessment cycle
   *  pass one; SINGLE_CYCLE_TREND_NOTE remains only for callers that don't, and
   *  is no longer asserted over a cycle-2 report by a mapper that could have
   *  known better. */
  trendFallback: string = SINGLE_CYCLE_TREND_NOTE,
): {
  aiSummary: AiSummaryBlock;
  dataQualityNote: string;
  trendNote: string;
} {
  return {
    aiSummary: { ...ai, dataQualityNote: "", trendNote: "" },
    dataQualityNote: ai.dataQualityNote || DATA_QUALITY_NOTE_UNAVAILABLE,
    trendNote: ai.trendNote || trendFallback,
  };
}

/** The report-level trend note for a snapshot, from its own cycle number. */
export function snapshotTrendNote(snapshot: ReportDataSnapshot): string {
  return deriveTrendNote({
    assessmentCycle: snapshot.study.assessmentCycle,
    currentSeverity: snapshot.severity.overallVillageNeedsIndex,
    priorCycleSeverity: null,
    scopeLabel: "this survey",
  });
}

/** Gemini `aiOutputJson` → our AI summary block (tolerant of missing fields). */
export function aiOutputToSummaryBlock(ai: Record<string, unknown> | null | undefined): AiSummaryBlock {
  const a = (ai ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  const keyFindings = Array.isArray(a.keyFindings)
    ? (a.keyFindings as Array<Record<string, unknown>>)
        .map((k) => str(k?.summary) || str(k?.title))
        .filter(Boolean)
        .join(" ")
    : str(a.keyFindings);

  const recommendationsRaw = Array.isArray(a.draftNextSteps)
    ? a.draftNextSteps
    : Array.isArray(a.recommendations)
      ? a.recommendations
      : [];

  return {
    executiveSummary: str(a.executiveSummary),
    keyFindings,
    dataQualityNote: str(a.dataQualityNote),
    trendNote: str(a.trendNote),
    recommendations: recommendationsRaw.map((r) => String(r)),
  };
}

// ── Survey-scoped mappers (RPT01 / RPT15) ──

/** Everything the two survey-scoped mappers need beyond the base MapperInput. */
export interface SurveyMapperInput extends MapperInput {
  survey: SurveyIdentity;
  coverage: CoverageBlock;
}

export interface CombinedMapperInput extends SurveyMapperInput {
  portfolio: PortfolioBlock;
  dashboard: CollectiveDashboardData;
  /** Live reviewer-SLA figures, overlaid the same way the dashboard screen does. */
  sla: { slaCompliancePct: number | null; breached: number; atRisk: number };
  /** When the (live) dashboard half was read, distinct from the snapshot stamp. */
  dashboardCapturedAt: string;
}

/**
 * The shared survey half of RPT01 and RPT15. Shares `header` + `severity` +
 * `priority` + `topKpis` with the village mapper on purpose — that's what makes
 * the existing gauge/radar/bars/donut renderers pick it up with no changes.
 *
 * RPT01 adds the six Unified Narrative sections on top (see
 * ReportSummaryDataProvider.getIndividualSurveyReport); RPT15 takes this alone.
 */
export function snapshotToSurveyBase(input: SurveyMapperInput): SurveyReportBase {
  const { snapshot, coverage } = input;
  const notes = promoteNotes(aiOutputToSummaryBlock(input.aiOutput), snapshotTrendNote(snapshot));
  // The trend note is a factual statement about which cycles have stored
  // rollups — a backend fact, not a narrative. The AI's version said trends
  // "could be established with comparative data" while the per-domain note on
  // the same page said no Cycle 2 rollup exists. Backend wins.
  const trendNote = snapshotTrendNote(snapshot);
  return {
    header: buildHeader(snapshot, input.methodologyVersion),
    survey: input.survey,
    coverage,
    responseQuality: mapResponseQuality(snapshot),
    severity: {
      // No `?? 0`: an unscored survey renders "—", not a Needs Index of zero
      // (which reads as "assessed, no needs found").
      overallVillageNeedsIndex: snapshot.severity.overallVillageNeedsIndex,
      label: snapshot.severity.severityBand,
      domains: mapDomains(snapshot),
    },
    priority: mapPriority(snapshot),
    topKpis: mapTopKpis(snapshot),
    responseFunnel: buildResponseFunnel(coverage),
    questionCoverage: buildQuestionCoverage(snapshot),
    qualitativeEvidence: snapshot.evidence.map((e) => ({ theme: e.evidenceTitle, summary: e.description })),
    aiSummary: notes.aiSummary,
    dataQualityNote: notes.dataQualityNote,
    trendNote,
    approval: input.approval ?? EMPTY_APPROVAL,
    demographics: input.demographics ?? null,
    filters: input.filters ?? {},
  };
}

// A missing priority assessment is "not calculable", not a score of 0 with a
// 'LOW' status — which contradicted the banding itself (≤40 → HIGH) and told a
// reader the village was the least urgent one in the study.
function mapPriority(snapshot: ReportDataSnapshot) {
  const score = snapshot.priority.villagePriorityScore;
  return {
    villagePriorityScore: score,
    priorityStatus: priorityStatusOf(score) as PriorityStatus | null,
    notCalculableReason:
      score === null
        ? "No village priority assessment is stored for this survey and scope — priority scoring has not been run, or no domain weights are configured."
        : null,
    overrideApplied: snapshot.priority.overrideApplied,
    overrideReason: snapshot.priority.overrideReason,
  };
}

/**
 * RPT15 Survey & Dashboard Report.
 *
 * The survey half is built from the SAME snapshot the individual mapper above
 * consumes — deliberately by calling it, not by re-deriving the blocks, so the
 * two reports cannot drift apart. The reconciliation spec asserts exactly this.
 */
export function snapshotToCombinedContent(input: CombinedMapperInput): CombinedReportContent {
  const individual = snapshotToSurveyBase(input);
  const { dashboard, sla } = input;

  return {
    header: individual.header,
    survey: individual.survey,
    coverage: individual.coverage,
    portfolio: input.portfolio,

    // Survey half — taken wholesale from the individual report's own blocks.
    responseQuality: individual.responseQuality,
    severity: individual.severity,
    priority: individual.priority,
    topKpis: individual.topKpis,
    responseFunnel: individual.responseFunnel,
    questionCoverage: individual.questionCoverage,
    demographics: individual.demographics,

    dashboard: {
      capturedAt: input.dashboardCapturedAt,
      kpis: {
        needCount: dashboard.needCount,
        slaCompliancePct: sla.slaCompliancePct,
        slaBreaches: sla.breached,
        slaAtRisk: sla.atRisk,
      },
      scoringDistribution: dashboard.scoringDistribution,
      topPriorities: dashboard.topPriorities,
      trends: dashboard.trends,
      // Flattened to strings — the renderers already have an "Anomalies
      // Flagged" list section, and severity is carried in the wording.
      anomalies: dashboard.anomalies.map((a) => `[${a.severity.toUpperCase()}] ${a.note}`),
      reviewerNotes: dashboard.reviewerNotes,
    },

    comparison: buildComparisonBand(input.snapshot, dashboard, input.coverage),

    aiSummary: individual.aiSummary,
    dataQualityNote: individual.dataQualityNote,
    trendNote: individual.trendNote,
    approval: individual.approval,
    filters: individual.filters,
  };
}

// ── Public mappers, one per report scope ──

export function snapshotToVillageContent(input: MapperInput): VillageReportContent {
  const { snapshot } = input;
  const notes = promoteNotes(aiOutputToSummaryBlock(input.aiOutput));
  return {
    header: buildHeader(snapshot, input.methodologyVersion),
    village: {
      id: snapshot.study.villageId,
      name: snapshot.study.villageName,
      assessmentCycle: snapshot.study.assessmentCycle,
      assessmentPeriod: input.assessmentPeriod ?? "",
    },
    responseQuality: mapResponseQuality(snapshot),
    severity: {
      overallVillageNeedsIndex: snapshot.severity.overallVillageNeedsIndex,
      label: snapshot.severity.severityBand,
      domains: mapDomains(snapshot),
    },
    priority: mapPriority(snapshot),
    topKpis: mapTopKpis(snapshot),
    qualitativeEvidence: snapshot.evidence.map((e) => ({ theme: e.evidenceTitle, summary: e.description })),
    aiSummary: notes.aiSummary,
    dataQualityNote: notes.dataQualityNote,
    trendNote: notes.trendNote,
    approval: input.approval ?? EMPTY_APPROVAL,
    // Real gender/rural aggregated from survey responses by the provider; null
    // when not captured → the charts show "Not available".
    demographics: input.demographics ?? null,
    filters: input.filters ?? {},
  };
}

export function snapshotToSectorContent(input: MapperInput): SectorReportContent {
  const { snapshot } = input;
  const notes = promoteNotes(aiOutputToSummaryBlock(input.aiOutput));
  return {
    header: buildHeader(snapshot, input.methodologyVersion),
    domains: mapDomains(snapshot),
    overall: {
      overallVillageNeedsIndex: snapshot.severity.overallVillageNeedsIndex,
      label: snapshot.severity.severityBand,
      domains: [],
    },
    aiSummary: notes.aiSummary,
    dataQualityNote: notes.dataQualityNote,
    trendNote: notes.trendNote,
    demographics: input.demographics ?? null,
    filters: input.filters ?? {},
  };
}

// One region row from this snapshot's scope. True multi-region aggregation is a
// follow-up (the REGION-scope snapshot still returns a single scoped view).
export interface RegionMapperInput extends MapperInput {
  /** Resolved by loadRegionBreakdown. Absent only if the caller could not
   *  resolve geography at all, in which case the report says so rather than
   *  falling back to a study-wide figure wearing a region's name. */
  breakdown?: RegionBreakdown | null;
}

/** How the per-governorate figures are derived — printed on the report. */
export const REGION_AGGREGATION_BASIS =
  "Severity per governorate is the cross-village mean of its scored villages, shown beside the worst single village. " +
  "Villages with no score are listed separately and excluded from the mean rather than counted as zero.";

export function snapshotToRegionContent(input: RegionMapperInput): RegionReportContent {
  const { snapshot, breakdown } = input;
  // Promote the data-quality and trend notes to first-class region fields, and
  // blank them inside aiSummary so the AI Summary block doesn't render them
  // twice.
  const notes = promoteNotes(aiOutputToSummaryBlock(input.aiOutput));

  // Region-scoped rows: one per governorate, from that governorate's OWN
  // villages. The previous behaviour printed the study-wide rollup under the
  // region's name, which read as a per-region figure and was not one — two
  // regions in the same study would have shown identical numbers.
  const regions = (breakdown?.governorates ?? []).map((g) => ({
    needCount: g.needCount,
    regionName: breakdown?.regionName ?? snapshot.study.regionName ?? snapshot.study.studyName,
    governorate: g.governorate,
    responseCount: g.responseCount,
    severityScore: g.severityScore,
    maxVillageSeverity: g.maxVillageSeverity,
    priorityScore: g.priorityScore,
    priorityStatus: priorityStatusOf(g.priorityScore),
  }));

  return {
    header: buildHeader(snapshot, input.methodologyVersion),
    regionScope: {
      regionName: breakdown?.regionName ?? snapshot.study.regionName ?? null,
      governorateCount: breakdown?.governorates.length ?? 0,
      villageCount: breakdown?.villages.length ?? 0,
      unmappedNeedCount: breakdown?.unmappedNeedCount ?? 0,
      unscoredVillages: breakdown?.unscoredVillages ?? [],
      aggregationBasis: REGION_AGGREGATION_BASIS,
    },
    regions,
    villages: breakdown?.villages ?? [],
    aiSummary: notes.aiSummary,
    dataQualityNote: notes.dataQualityNote,
    trendNote: notes.trendNote,
    demographics: input.demographics ?? null,
    filters: input.filters ?? {},
  };
}

export function snapshotToExecutiveContent(input: MapperInput): ExecutiveReportContent {
  const { snapshot } = input;
  const anomalies = mapDomains(snapshot)
    .filter((d) => d.confidence === "LOW" || d.isCriticalDomain)
    .map((d) =>
      d.confidence === "LOW"
        ? `${d.name} flagged: Low Confidence (severity ${d.severityScore}).`
        : `${d.name}: critical domain (performance ${d.performanceScore}).`,
    );
  const notes = promoteNotes(aiOutputToSummaryBlock(input.aiOutput));
  return {
    header: buildHeader(snapshot, input.methodologyVersion),
    scope: {
      villages: snapshot.study.villageName,
      governorate: snapshot.study.governorateName ?? null,
    },
    topPriorities: mapTopKpis(snapshot),
    responseQuality: mapResponseQuality(snapshot),
    aiSummary: notes.aiSummary,
    dataQualityNote: notes.dataQualityNote,
    trendNote: notes.trendNote,
    anomalies,
    reviewerNotes: null,
    demographics: input.demographics ?? null,
    filters: input.filters ?? {},
  };
}
