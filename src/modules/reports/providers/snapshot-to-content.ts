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
  type ConfidenceLevel,
  type Demographics,
  type DomainComponent,
  type ExecutiveReportContent,
  type PriorityStatus,
  type RegionReportContent,
  type ReportHeader,
  type ResponseQuality,
  type SectorReportContent,
  type TopKpi,
  type VillageReportContent,
} from "../report-content.types";

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
    // Valid-response ratio as a quantitative confidence %. No submissions → 100
    // (nothing was dropped), same convention as the domain confidence %.
    confidencePct: submitted > 0 ? Math.round((rq.validResponseCount / submitted) * 100) : 100,
    dontKnowRate: rq.dontKnowRate,
  };
}

type DomainSeverityScore = ReportDataSnapshot["severity"]["domainSeverityScores"][number];

// Quantitative confidence % = valid-response ratio (valid / submitted × 100),
// rounded. submitted = valid + excluded. No responses at all → 100 (nothing was
// dropped) rather than a misleading 0.
function validResponseRatioPct(ds: DomainSeverityScore | undefined): number {
  if (!ds) return 100;
  const submitted = ds.validResponseCount + ds.excludedResponseCount;
  return submitted > 0 ? Math.round((ds.validResponseCount / submitted) * 100) : 100;
}

// Domains carry both severity (from severity.domainSeverityScores) and the
// priority-scoring detail (from priority.domainPerformanceScores). The latter
// already matches DomainComponent 1:1; we join the former for confidence,
// confidence %, KPI count and the domain code.
function mapDomains(snapshot: ReportDataSnapshot): DomainComponent[] {
  const byKey = new Map(snapshot.severity.domainSeverityScores.map((d) => [d.domainKey, d]));
  const perf = snapshot.priority.domainPerformanceScores;

  if (perf.length > 0) {
    return perf.map((dp) => {
      const ds = byKey.get(dp.domainKey);
      const confidence = normConfidence(ds?.confidenceLevel);
      const base: DomainComponent = {
        name: dp.domainName,
        domainCode: dp.domainKey,
        severityScore: dp.severityScore,
        performanceScore: dp.performanceScore,
        weight: dp.weight,
        weightedContribution: dp.weightedContribution,
        confidence,
        confidencePct: validResponseRatioPct(ds),
        kpiCount: ds?.kpiCount ?? 0,
        trendNote: SINGLE_CYCLE_TREND_NOTE,
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
      severityScore: ds.severityScore ?? 0,
      performanceScore: 0,
      weight: 0,
      weightedContribution: 0,
      confidence,
      confidencePct: validResponseRatioPct(ds),
      kpiCount: ds.kpiCount,
      trendNote: SINGLE_CYCLE_TREND_NOTE,
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
    severityScore: k.severityScore ?? 0,
    confidence: normConfidence(k.confidenceLevel),
    validResponseCount: k.validResponseCount,
  }));
}

/**
 * Promote the Data Quality and Trend notes out of the AI summary into
 * first-class report fields, applying placeholders so every report carries both
 * consistently (never blank). Returns the aiSummary with its note copies blanked
 * (so renderers don't show them twice) plus the two promoted values.
 */
export function promoteNotes(ai: AiSummaryBlock): {
  aiSummary: AiSummaryBlock;
  dataQualityNote: string;
  trendNote: string;
} {
  return {
    aiSummary: { ...ai, dataQualityNote: "", trendNote: "" },
    dataQualityNote: ai.dataQualityNote || DATA_QUALITY_NOTE_UNAVAILABLE,
    trendNote: ai.trendNote || SINGLE_CYCLE_TREND_NOTE,
  };
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
      overallVillageNeedsIndex: snapshot.severity.overallVillageNeedsIndex ?? 0,
      label: snapshot.severity.severityBand,
      domains: mapDomains(snapshot),
    },
    priority: {
      villagePriorityScore: snapshot.priority.villagePriorityScore,
      priorityStatus: snapshot.priority.priorityStatus as PriorityStatus,
      overrideApplied: snapshot.priority.overrideApplied,
      overrideReason: snapshot.priority.overrideReason,
    },
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
      overallVillageNeedsIndex: snapshot.severity.overallVillageNeedsIndex ?? 0,
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
export function snapshotToRegionContent(input: MapperInput): RegionReportContent {
  const { snapshot } = input;
  // Promote the data-quality and trend notes to first-class region fields, and
  // blank them inside aiSummary so the AI Summary block doesn't render them
  // twice.
  const notes = promoteNotes(aiOutputToSummaryBlock(input.aiOutput));
  return {
    header: buildHeader(snapshot, input.methodologyVersion),
    regions: [
      // Keys ordered for the auto-derived table (renderers preserve insertion
      // order): identity → responses → severity beside priority. needCount kept
      // first to match the report's existing column layout.
      {
        needCount: snapshot.severity.topKpis.length,
        // The actual region where the study was conducted (from its
        // governorates' parent Region), not the consolidated-scope label. Falls
        // back to the study name when no region is linked.
        regionName: snapshot.study.regionName || snapshot.study.studyName,
        governorate: snapshot.study.governorateName ?? null,
        responseCount: snapshot.responseQuality.validResponseCount,
        severityScore: snapshot.severity.overallVillageNeedsIndex ?? 0,
        priorityScore: snapshot.priority.villagePriorityScore,
        priorityStatus: snapshot.priority.priorityStatus as PriorityStatus,
      },
    ],
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
