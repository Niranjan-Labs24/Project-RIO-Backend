import type { ConfidenceFlag, Thresholds, UnitGeo } from "../need-record.types";
import type { UnifiedRpt01Sections } from "../unified-report.types";
import { buildNeedRecords, type ClassificationRow, type KpiRollupRow } from "./build-need-records";
import { buildNeedHierarchy, type DomainMeta, type RollupLevelValue } from "./build-need-hierarchy";
import { composeDataQualityNotes } from "./compose-data-quality-notes";
import { composeExecutiveSummary, type MethodologyDomain } from "./compose-executive-summary";
import { composePatternAnalysis } from "./compose-pattern-analysis";
import { deriveTrendNote } from "./derive-trend-note";
import { gapTypeBasis } from "./derive-gap-type";
import { RANKING_BASIS, rankPriorityNeeds } from "./rank-priority-needs";
import type { SegmentRow } from "./derive-equity-flag";
import { PRIORITY_DIRECTION_NOTE, priorityStatusOf, severityBandOf } from "./severity-bands";

// Composes sections 2–6 of the Unified Narrative Report Structure for RPT01.
//
// PURE — no DB, no AI, no I/O. Every figure it emits is derived from the inputs
// by arithmetic the Calculation Basis appendix prints, which is what makes the
// numbers testable without a database and what answers the client's
// reproducibility objection.
//
// The only LLM-authored strings in the finished report are the AI Summary
// narrative fields. Every band, adjective and threshold below is computed here
// and must be used verbatim by the prompt.

export interface UnifiedRpt01Input {
  generatedAt: string;
  surveyId: string;
  surveyTitle: string;
  studyId: string;
  snapshotId: string;
  methodologyVersionId: string;
  methodologyVersionLabel: string;
  assessmentCycle: number;
  calculatedAt: string;
  /** '' for the consolidated scope, else the village id. Part of the need id. */
  villageScope: string;
  unitGeo: UnitGeo;
  /** The source Need's own affected-population estimate — see
   *  BuildNeedRecordsInput.sourceNeedAffectedPopulation. */
  sourceNeedAffectedPopulation: number | null;

  kpiRollups: KpiRollupRow[];
  classificationByIndicator: Map<string, ClassificationRow>;
  segmentsByIndicator: Map<string, SegmentRow[]>;
  priorCycleByIndicator: Map<string, number>;
  subDomainByKey: Map<string, RollupLevelValue>;
  indicatorByKey: Map<string, RollupLevelValue>;
  domainMetaByKey: Map<string, DomainMeta>;
  /** ALL methodology domains, not just the assessed ones. */
  allDomains: MethodologyDomain[];
  domainWeightByKey: Map<string, number | null>;

  overallNeedsIndex: number | null;
  overallConfidence: ConfidenceFlag;
  overallConfidenceReason: string;
  priorCycleOverallSeverity: number | null;

  responseQuality: {
    submitted: number;
    valid: number;
    excluded: number;
    dontKnowRate: number;
    duplicatesFlagged: number;
    lowConfidenceFlagged: number;
  };
  dontKnowRateByDomain: Array<{ domain: string; rate: number }>;
  exclusionBreakdown: Array<{ status: string; count: number }>;
  totalAnswers: number;

  villagePriority: {
    priorityScore: number | null;
    overrideApplied: boolean;
    overrideReason: string | null;
    /** Σ of the weights of the domains that were actually assessed. */
    assessedWeightSum: number | null;
  };

  thresholds: Thresholds;
}

export function buildUnifiedRpt01(input: UnifiedRpt01Input): UnifiedRpt01Sections {
  const {
    generatedAt,
    surveyId,
    surveyTitle,
    studyId,
    snapshotId,
    methodologyVersionId,
    methodologyVersionLabel,
    assessmentCycle,
    calculatedAt,
    villageScope,
    unitGeo,
    sourceNeedAffectedPopulation,
    kpiRollups,
    classificationByIndicator,
    segmentsByIndicator,
    priorCycleByIndicator,
    subDomainByKey,
    indicatorByKey,
    domainMetaByKey,
    allDomains,
    domainWeightByKey,
    overallNeedsIndex,
    overallConfidence,
    overallConfidenceReason,
    priorCycleOverallSeverity,
    responseQuality,
    dontKnowRateByDomain,
    exclusionBreakdown,
    totalAnswers,
    villagePriority,
    thresholds,
  } = input;

  // ── The atoms ──
  const needRecords = buildNeedRecords({
    kpiRollups,
    classificationByIndicator,
    segmentsByIndicator,
    priorCycleByIndicator,
    unitGeo,
    sourceRefBase: {
      kind: "survey_rollup",
      surveyId,
      surveyTitle,
      studyId,
      rollupLevel: "KPI",
      methodologyVersionId,
      methodologyVersionLabel,
      snapshotId,
      assessmentCycle,
      calculatedAt,
    },
    thresholds,
    surveyId,
    villageScope,
    sourceNeedAffectedPopulation,
  });

  // ── Section 3 — the domain → sub-domain → indicator tree ──
  const needsByDomain = buildNeedHierarchy({
    needRecords,
    domainMetaByKey,
    subDomainByKey,
    indicatorByKey,
    assessmentCycle,
  });

  // ── Section 5 — Priority Needs ──
  const { ranked, notMeasured } = rankPriorityNeeds(needRecords, domainWeightByKey);

  const assessedDomainKeys = new Set(needsByDomain.map((d) => d.domainKey));
  const domainsNotAssessed = allDomains
    .filter((d) => !assessedDomainKeys.has(d.domainKey))
    .map((d) => d.domain);

  // ── Section 2 — Executive Summary ──
  const domainSeverityByKey = new Map(needsByDomain.map((d) => [d.domainKey, d.severityScore]));
  const domainBandByKey = new Map(
    needsByDomain.map((d) => [d.domainKey, severityBandOf(d.severityScore) as string | null]),
  );
  const subDomainsAssessedByKey = new Map(
    needsByDomain.map((d) => [d.domainKey, d.subDomains.length]),
  );

  const executiveSummary = composeExecutiveSummary({
    allDomains,
    needRecords,
    rankedNeeds: ranked,
    domainSeverityByKey,
    domainBandByKey,
    subDomainsAssessedByKey,
  });

  // ── Section 4 — Pattern & Intersection Analysis ──
  const patternAnalysis = composePatternAnalysis({
    needRecords,
    validResponseCount: responseQuality.valid,
    domainsAssessed: needsByDomain.length,
    domainsNotAssessed,
    thresholds,
  });

  // ── Section 6 — Data Quality Notes (mandatory) ──
  const overallTrendNote = deriveTrendNote({
    assessmentCycle,
    currentSeverity: overallNeedsIndex,
    priorCycleSeverity: priorCycleOverallSeverity,
    scopeLabel: "this survey",
  });

  const dataQualityNotes = composeDataQualityNotes({
    submitted: responseQuality.submitted,
    valid: responseQuality.valid,
    excluded: responseQuality.excluded,
    dontKnowRate: responseQuality.dontKnowRate,
    dontKnowRateByDomain,
    exclusionBreakdown,
    totalAnswers,
    duplicatesFlagged: responseQuality.duplicatesFlagged,
    lowConfidenceFlagged: responseQuality.lowConfidenceFlagged,
    needRecords,
    domainsNotAssessed,
    domainsInMethodology: allDomains.length,
    confidenceFlag: overallConfidence,
    confidenceReason: overallConfidenceReason,
    thresholds,
    trendNote: overallTrendNote,
  });

  // ── Village priority, with an honest not-calculable state ──
  const priorityScore = villagePriority.priorityScore;
  const coverageBasis =
    villagePriority.assessedWeightSum !== null
      ? `Computed over the ${needsByDomain.length} assessed domain(s), whose methodology weights sum to ${villagePriority.assessedWeightSum.toFixed(2)} of 1.00. The weighted mean is renormalised across those domains; unassessed domains contribute nothing and are not treated as scoring well.`
      : `Coverage basis unavailable — no domain priority weights are configured for this methodology version, so no weighted score could be produced.`;

  return {
    reportMeta: {
      reportType: "RPT01",
      reportTypeName: "Individual Survey Report",
      sourceBasis: "SURVEY_ONLY",
      isQuantitative: true,
      severityScorePolicy: "measured",
      contentVersion: 2,
      generatedAt,
    },
    unitGeo,
    executiveSummary,
    needsByDomain,
    patternAnalysis,
    priorityNeeds: {
      rankingBasis: RANKING_BASIS,
      needs: ranked,
      villagePriority: {
        priorityScore,
        priorityStatus: priorityStatusOf(priorityScore),
        notCalculableReason:
          priorityScore === null
            ? "No village priority assessment is stored for this survey and scope — priority scoring has not been run, or no domain weights are configured. Shown as not calculable rather than as a score of 0."
            : null,
        overrideApplied: villagePriority.overrideApplied,
        overrideReason: villagePriority.overrideReason,
        coverageBasis,
        scoreDirectionNote: PRIORITY_DIRECTION_NOTE,
      },
      notMeasured,
    },
    dataQualityNotes,
    calculationBasis: buildCalculationBasis({
      needsByDomain,
      overallNeedsIndex,
      priorityScore,
      assessedWeightSum: villagePriority.assessedWeightSum,
      thresholds,
    }),
    needRecords,
  };
}

/**
 * A narrative composed from the figures, for when the LLM is unavailable or its
 * cached output was written against a superseded prompt.
 *
 * Every sentence is traceable to a number in the sections above — nothing is
 * characterised beyond the bands the backend already decided. A report with no
 * narrative at all is a worse outcome than a plain one, and reusing a stale
 * narrative is worse than both.
 */
export function composeDeterministicNarrative(sections: UnifiedRpt01Sections): {
  executiveSummary: string;
  keyFindings: string;
} {
  const es = sections.executiveSummary;
  const top = es.topThreeCriticalNeeds;
  const measured = sections.needsByDomain.filter((d) => d.severityScore !== null);
  const vp = sections.priorityNeeds.villagePriority;

  const executiveSummary = [
    `This survey-only assessment scored ${es.measuredCount} of ${es.totalNeedsExtracted} indicator(s) across ${es.domainsAssessed} of the methodology's ${es.domainsInMethodology} domains.`,
    measured.length
      ? `Assessed domains: ${measured.map((d) => `${d.domain} ${d.severityScore!.toFixed(2)}`).join(", ")}.`
      : `No domain returned a measurable severity.`,
    vp.priorityScore === null
      ? `Village Priority Score is not calculable. ${vp.notCalculableReason}`
      : `Village Priority Score is ${vp.priorityScore.toFixed(2)} (${vp.priorityStatus}). ${vp.scoreDirectionNote}`,
    `Confidence is ${sections.dataQualityNotes.confidence.flag}. ${sections.dataQualityNotes.confidence.reason}`,
    `Domains that were not assessed carry no score; their absence is not a finding of low need.`,
  ].join(" ");

  const keyFindings = top.length
    ? top
        .map(
          (n) =>
            `${n.rank}. ${n.indicatorName} (${n.domain} → ${n.subDomain}) — severity ${n.severityScore!.toFixed(2)} ${n.severityBand}, confidence ${n.confidence}, gap type ${n.gapType ?? "not classified"}.`,
        )
        .join(" ")
    : "No indicator returned a measurable severity, so no findings can be ranked.";

  return { executiveSummary, keyFindings };
}

/** The arithmetic, with this report's own numbers in it. */
function buildCalculationBasis(input: {
  needsByDomain: UnifiedRpt01Sections["needsByDomain"];
  overallNeedsIndex: number | null;
  priorityScore: number | null;
  assessedWeightSum: number | null;
  thresholds: Thresholds;
}): UnifiedRpt01Sections["calculationBasis"] {
  const { needsByDomain, overallNeedsIndex, priorityScore, assessedWeightSum, thresholds: t } = input;

  const needsIndexWorking = needsByDomain.map((d) =>
    d.severityScore === null
      ? `${d.domain}: not measured — excluded from the mean (it is NOT counted as 0).`
      : `${d.domain}: ${d.severityScore.toFixed(2)} (mean of ${d.subDomains.length} sub-domain score(s))`,
  );
  const measured = needsByDomain.filter((d) => d.severityScore !== null);
  needsIndexWorking.push(
    overallNeedsIndex === null
      ? "Needs Index: not measured — no domain returned a score."
      : `Needs Index = (${measured.map((d) => d.severityScore!.toFixed(2)).join(" + ")}) / ${measured.length} = ${overallNeedsIndex.toFixed(2)}`,
  );

  const priorityScoreWorking = needsByDomain.map((d) =>
    d.severityScore === null || d.weight === null
      ? `${d.domain}: no weighted contribution (${d.severityScore === null ? "severity not measured" : "no weight configured"})`
      : `${d.domain}: performance (100 − ${d.severityScore.toFixed(2)}) = ${(100 - d.severityScore).toFixed(2)} × weight ${d.weight} = ${((100 - d.severityScore) * d.weight).toFixed(4)}`,
  );
  priorityScoreWorking.push(
    priorityScore === null
      ? "Priority Score: not calculable — no stored village priority assessment."
      : `Priority Score = Σ weighted contributions${assessedWeightSum ? ` / ${assessedWeightSum.toFixed(2)} (renormalised over assessed domains)` : ""} = ${priorityScore.toFixed(2)}`,
  );

  return {
    needsIndexFormula:
      "Needs Index = mean of the measured DOMAIN severities. A domain is the mean of its measured sub-domains, a sub-domain the mean of its measured indicators, an indicator the mean of its measured KPIs, a KPI the mean of its scored answers. Unmeasured levels are skipped at every step, never counted as 0.",
    needsIndexWorking,
    priorityScoreFormula:
      "Priority Score = Σ((100 − domain severity) × domain weight) renormalised over the assessed domains' weight sum. Performance-based, so LOWER means more urgent.",
    priorityScoreWorking,
    severityBandingRule: "Severity 0–100 (higher = worse): ≥70 CRITICAL, ≥50 HIGH, ≥30 MEDIUM, <30 LOW. A measured 0 is LOW; an unmeasured indicator is null and shown as '—'.",
    confidenceRule: `Confidence is LOW when valid responses < ${t.confidenceMinSample} OR the don't-know rate > ${(t.dontKnowLowThreshold * 100).toFixed(0)}%; otherwise STANDARD. The stated reason names only the condition that actually fired.`,
    equityRule: `Equity flag fires when the severity spread (max − min) across a dimension's groups ≥ ${t.equitySpreadThreshold} points AND every compared group has n ≥ ${t.equityMinGroupN}. When no dimension clears the group minimum the flag is false and the reason says the sample was too small — it is not a finding of no inequity.`,
    gapTypeRule: gapTypeBasis(t),
    thresholds: t,
  };
}
