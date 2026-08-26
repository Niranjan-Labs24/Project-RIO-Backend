// Pure mappers for the two focused reports — RPT03/RPT09 Top-Priority and
// RPT10 Data-Quality.
//
// Both PROJECT the unified pipeline's own output (buildUnifiedRpt01) rather
// than re-aggregating from the snapshot. That is deliberate and it is the whole
// reconciliation argument: `priorityNeeds`, `calculationBasis` and
// `dataQualityNotes` are passed through as the SAME objects RPT01 carries, so
// the figures cannot drift between the three reports. A parallel aggregation
// would satisfy acceptance criterion 3 only by coincidence, and only until
// someone edited one of the two code paths.
//
// No DB, no AI, no I/O — same rule as snapshot-to-content.ts.

import type {
  AiSummaryBlock,
  DataQualityReportContent,
  Demographics,
  DomainPriorityRollupRow,
  FocusedReportMeta,
  PriorityTierRow,
  ReportHeader,
  ResponseQuality,
  TopPriorityReportContent,
} from "../report-content.types";
import type { UnifiedRpt01Sections } from "../unified-report.types";
import type { DomainComponent } from "../report-content.types";
import type { NeedRecord, SeverityBand } from "../need-record.types";
import type { DataCollectionCompletenessBlock } from "./load-data-collection-completeness";
import { severityBandOf } from "./severity-bands";
// The masking comparison itself lives in derive-domain-masking.ts, shared with
// the Village/Sector/Region domain tables — see that file's header.
import { deriveDomainMasking } from "./derive-domain-masking";

/** Band order, worst first — drives the tier table's row order. */
const BAND_ORDER: SeverityBand[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

export interface FocusedMapperInput {
  header: ReportHeader;
  unified: UnifiedRpt01Sections;
  responseQuality: ResponseQuality;
  aiSummary: AiSummaryBlock;
  dataQualityNote: string;
  trendNote: string;
  demographics?: Demographics | null;
  /** Domain rows from the survey base — carries the methodology's KPI counts. */
  domains: DomainComponent[];
  scope?: { villages: string; governorate: string | null };
  filters?: Record<string, unknown>;
  /** RPT10 only — data-collection completeness (unanswered required questions,
   *  abandonment, and the combined invalid-response count). Optional so the
   *  Top-Priority mapper, which shares this input type, is unaffected. */
  dataCollection?: DataCollectionCompletenessBlock;
}

function focusedMeta(
  reportType: string,
  reportTypeName: string,
  generatedAt: string,
): FocusedReportMeta {
  return {
    reportType,
    reportTypeName,
    // Same basis as RPT01: these reports read survey-derived scores only. The
    // badge is what stops a reader assuming uploaded evidence was considered.
    sourceBasis: "SURVEY_ONLY",
    isQuantitative: true,
    severityScorePolicy: "measured",
    contentVersion: 1,
    generatedAt,
  };
}

/**
 * Tier distribution over RANKED needs.
 *
 * Unmeasured needs are excluded from the percentages on purpose — they have no
 * severity, so banding them would invent one. They are reported by
 * `priorityNeeds.notMeasured` instead, which is what keeps the two figures
 * honest: ranked + notMeasured always equals the total need count.
 */
export function buildTierSummary(needs: NeedRecord[]): PriorityTierRow[] {
  const measured = needs.filter((n) => n.severityScore !== null);
  const total = measured.length;

  return BAND_ORDER.map((tier) => {
    const inTier = measured.filter((n) => severityBandOf(n.severityScore) === tier);
    return {
      tier,
      count: inTier.length,
      // No measured needs → 0, not NaN. A report that prints "NaN%" is worse
      // than one that prints a zero it can explain.
      sharePct: total > 0 ? Number(((inTier.length / total) * 100).toFixed(1)) : 0,
      equityFlagged: inTier.filter((n) => n.equityFlag).length,
    };
  });
}

/**
 * Per-domain rollup carrying the average AND the worst KPI beneath it.
 *
 * The methodology's no-masking rule (METH — Domain Comparison, "Critical need
 * present — surfaces regardless of the average"): a domain can average LOW
 * while hiding a CRITICAL KPI. `masksCriticalFinding` is set when the domain's
 * own band is milder than its worst KPI's band, so the row can be highlighted
 * rather than leaving a reader to notice the discrepancy themselves.
 */
export function buildDomainRollup(
  domains: DomainComponent[],
  needs: NeedRecord[],
): DomainPriorityRollupRow[] {
  const byDomainKey = new Map<string, NeedRecord[]>();
  for (const n of needs) {
    const list = byDomainKey.get(n.domainKey);
    if (list) list.push(n);
    else byDomainKey.set(n.domainKey, [n]);
  }

  return domains.map((d) => {
    const records = byDomainKey.get(d.domainCode) ?? [];
    const masking = deriveDomainMasking(
      d.severityScore,
      records.map((r) => ({ domainKey: r.domainKey, kpiName: r.kpiName, severityScore: r.severityScore })),
    );

    return {
      domain: d.name,
      domainKey: d.domainCode,
      averageSeverity: d.severityScore,
      maxKpiSeverity: masking.maxKpiSeverity,
      criticalKpiCount: masking.criticalKpiCount,
      // The methodology's KPI count for the domain, not the number we happened
      // to measure — the two differ, and the difference is itself a finding.
      kpiCount: d.kpiCount,
      masksCriticalFinding: masking.masksCriticalFinding,
    };
  });
}

/** RPT03 / RPT09 — Top-Priority Report. */
export function buildTopPriorityContent(input: FocusedMapperInput): TopPriorityReportContent {
  const { unified } = input;

  return {
    header: input.header,
    reportMeta: focusedMeta("RPT03", "Top-Priority Report", unified.reportMeta.generatedAt),
    unitGeo: unified.unitGeo,
    scope: input.scope ?? { villages: "Consolidated Villages", governorate: null },
    tierSummary: buildTierSummary(unified.needRecords),
    domainRollup: buildDomainRollup(input.domains, unified.needRecords),
    // Passed through, not recomputed — see the file header.
    priorityNeeds: unified.priorityNeeds,
    needsByDomain: unified.needsByDomain,
    calculationBasis: unified.calculationBasis,
    responseQuality: input.responseQuality,
    aiSummary: input.aiSummary,
    dataQualityNote: input.dataQualityNote,
    trendNote: input.trendNote,
    demographics: input.demographics ?? null,
    filters: input.filters ?? {},
  };
}

/** RPT10 — Data-Quality Report. */
export function buildDataQualityContent(input: FocusedMapperInput): DataQualityReportContent {
  const { unified, responseQuality: rq } = input;
  const dq = unified.dataQualityNotes;

  // Headline tiles. Ordered so a reader meets volume before judgement: how much
  // came in, how much survived, then what that means for confidence.
  const completeness: Array<{ label: string; value: string }> = [
    { label: "Responses Submitted", value: String(dq.responseQuality.submitted) },
    { label: "Responses Valid", value: String(dq.responseQuality.valid) },
    { label: "Responses Excluded", value: String(dq.responseQuality.excluded) },
    { label: "Valid-Response Rate", value: `${dq.responseQuality.validResponseRatePct}%` },
    {
      label: "Don't-Know Rate",
      value: `${dq.responseQuality.dontKnowRatePct}% (${dq.responseQuality.dontKnowBand})`,
    },
    { label: "Duplicates Flagged", value: String(dq.responseQuality.duplicatesFlagged) },
    { label: "Low-Confidence Responses", value: String(dq.responseQuality.lowConfidenceFlagged) },
    { label: "Overall Confidence", value: `${dq.confidence.flag} — ${dq.confidence.reason}` },
    {
      label: "Sample Size vs Threshold",
      value: `${dq.confidence.sampleSize} valid / ${dq.confidence.sampleThreshold} required`,
    },
    {
      label: "Required Sample Size (study)",
      // Studies created before RIO-FR-024 have no target; say so rather than
      // printing a 0 that reads as "no responses needed".
      value: rq.requiredSampleSize === null ? "Not set for this study" : String(rq.requiredSampleSize),
    },
    { label: "Indicators Not Measurable", value: String(dq.notMeasuredCount) },
    { label: "Domains Not Assessed", value: String(dq.domainsNotAssessed.length) },
  ];

  // Data-collection completeness (client Q14 answer (a), and the 24 Aug
  // follow-up on abandonment). Appended to the same tile band rather than
  // given a band of its own: a reader judging whether this dataset can be
  // relied on needs "how much never arrived" beside "how much was excluded",
  // not two screens apart.
  const dc = input.dataCollection;
  if (dc) {
    completeness.push(
      { label: "Scope of these figures", value: dc.scope.level === "SURVEY" ? "One survey" : `All ${dc.scope.surveysInStudy} survey(s) in study` },
      { label: "Sessions Started", value: String(dc.abandonment.sessionsStarted) },
      { label: "Sessions Submitted", value: String(dc.abandonment.submitted) },
      { label: "Sessions Abandoned", value: String(dc.abandonment.abandoned) },
      {
        label: "Abandonment Rate",
        // The threshold travels with the number. A rate whose definition is a
        // config value must never be printed as a bare percentage.
        value: `${dc.abandonment.abandonmentRatePct}% (of ${dc.abandonment.resolvedSessions} resolved session(s), abandoned after ${dc.abandonment.idleThresholdMinutes}m idle)`,
      },
      {
        label: "Invalid Responses (incl. abandoned)",
        value: `${dc.invalidResponses.total} — ${dc.invalidResponses.excludedSubmitted} excluded + ${dc.invalidResponses.abandonedSessions} abandoned`,
      },
      {
        label: "Unanswered Required Questions",
        value: `${dc.unansweredRequired.unansweredCount} of ${dc.unansweredRequired.requiredAnswerSlots} (${dc.unansweredRequired.unansweredRatePct}%)`,
      },
    );
  }

  const dontKnowByDomain = new Map(dq.dontKnowRateByDomain.map((r) => [r.domain, r.rate]));

  const domainConfidence = input.domains.map((d) => ({
    domain: d.name,
    confidence: d.confidence,
    reason: d.confidenceReason,
    validResponseRatePct: d.validResponseRatePct,
    dontKnowRatePct: Number(((dontKnowByDomain.get(d.name) ?? d.dontKnowRate ?? 0) * 100).toFixed(2)),
    kpiCount: d.kpiCount,
  }));

  // AC 6 — every incomplete or unassessed item becomes a ROW. Nothing here is
  // filtered out of the report; the flag column says why it is listed. The
  // spec asserts flaggedRecords.length === notMeasuredCount + domainsNotAssessed.length.
  const flaggedRecords = [
    ...dq.notMeasured.map((n) => ({
      indicatorName: n.indicatorName,
      domain: n.domain,
      flag: "NOT_MEASURABLE",
      reason: n.reason,
    })),
    ...dq.domainsNotAssessed.map((domain) => ({
      indicatorName: "—",
      domain,
      flag: "DOMAIN_NOT_ASSESSED",
      reason: "No survey question in this study covers this methodology domain.",
    })),
    // Same AC-6 rule applied to the two new counts: every abandoned session
    // and every required question with a gap becomes a row. A count without
    // its rows is the silent exclusion the criterion prohibits, and that
    // applies to the counts added on 24 Aug exactly as it did to the others.
    ...(dc?.abandonment.detail ?? []).map((a) => ({
      indicatorName: `Session ${a.sessionRef}`,
      domain: "—",
      flag: "ABANDONED_SESSION",
      reason:
        `Started ${a.startedAt}, last activity ${a.lastActivityAt}, stopped at: ${a.stageLabel} (${a.progress}). ` +
        "Counted as an invalid response. No partial answers were stored.",
    })),
    ...(dc?.unansweredRequired.byQuestion ?? []).map((q) => ({
      indicatorName: `Q${q.questionRef} — ${q.questionText}`,
      domain: q.domain,
      flag: "REQUIRED_QUESTION_UNANSWERED",
      reason: `${q.unanswered} of ${q.ofResponses} submitted response(s) left this required question blank (${q.unansweredPct}%).`,
    })),
  ];

  return {
    header: input.header,
    reportMeta: focusedMeta("RPT10", "Data-Quality Report", unified.reportMeta.generatedAt),
    unitGeo: unified.unitGeo,
    dataQualityNotes: dq,
    completeness,
    domainConfidence,
    flaggedRecords,
    dataCollection: dc ?? null,
    responseQuality: rq,
    aiSummary: input.aiSummary,
    dataQualityNote: input.dataQualityNote,
    trendNote: input.trendNote,
    filters: input.filters ?? {},
  };
}
