import type { ConfidenceFlag, SeverityBand, Thresholds, UnitGeo } from "../need-record.types";
import { DEFAULT_APP_LOCALE, type AppLocale } from "../../../i18n/locale";
import { translator } from "../../../i18n/translate";
import { currentLocale } from "../../../tenancy/org-context";
import {
  confidenceFlagLabel,
  priorityDirectionNote,
  priorityStatusLabel,
  severityBandLabel,
} from "./severity-bands";
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
import { priorityStatusOf, severityBandOf } from "./severity-bands";

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
  // The caller's language, for the methodology explanations this function
  // composes. Read from the request context rather than passed in: every call
  // site is inside a request, and threading it through UnifiedRpt01Input would
  // touch every fixture that builds one.
  const locale = currentLocale();
  const t = translator(locale);
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
      ? t("calc.coverageBasis", {
          domains: needsByDomain.length,
          weight: villagePriority.assessedWeightSum.toFixed(2),
        })
      : t("calc.coverageBasisUnavailable");

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
        scoreDirectionNote: priorityDirectionNote(locale),
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
export function composeDeterministicNarrative(
  sections: UnifiedRpt01Sections,
  /**
   * Language to compose in. Defaults to English so every existing caller is
   * unchanged.
   *
   * This narrative is prose, so unlike a label it cannot be substituted at
   * export time — it has to be built in the right language from the start. It
   * is also the ONLY narrative that can be produced without the model, which
   * makes it the one an Arabic report falls back to when the AI is unavailable.
   */
  locale: AppLocale = DEFAULT_APP_LOCALE,
): {
  executiveSummary: string;
  keyFindings: string;
} {
  const es = sections.executiveSummary;
  const top = es.topThreeCriticalNeeds;
  const measured = sections.needsByDomain.filter((d) => d.severityScore !== null);
  const vp = sections.priorityNeeds.villagePriority;
  const t = translator(locale);

  const executiveSummary = [
    t("narrative.det.scored", {
      measured: es.measuredCount,
      total: es.totalNeedsExtracted,
      domains: es.domainsAssessed,
      allDomains: es.domainsInMethodology,
    }),
    measured.length
      ? // Domain names are reference data and stay in the language the
        // catalogue holds them in — the sentence around them is translated,
        // the names are not invented here.
        t("narrative.det.assessedDomains", {
          list: measured.map((d) => `${d.domain} ${d.severityScore!.toFixed(2)}`).join(", "),
        })
      : t("narrative.det.noMeasurableSeverity"),
    vp.priorityScore === null
      ? // `notCalculableReason` is nullable. The previous template literal
        // interpolated it directly, so a null reason printed the word "null"
        // into the narrative; an empty string leaves the sentence complete
        // without it.
        t("narrative.det.priorityNotCalculable", { reason: vp.notCalculableReason ?? "" }).trim()
      : t("narrative.det.priorityScore", {
          score: vp.priorityScore.toFixed(2),
          status: priorityStatusLabel(vp.priorityStatus as "HIGH" | "MEDIUM" | "LOW", locale),
          note: priorityDirectionNote(locale),
        }),
    t("narrative.det.confidence", {
      flag: confidenceFlagLabel(sections.dataQualityNotes.confidence.flag as "LOW" | "STANDARD", locale),
      reason: sections.dataQualityNotes.confidence.reason,
    }),
    t("narrative.det.unassessedNote"),
  ].join(" ");

  const keyFindings = top.length
    ? top
        .map((n) =>
          t("narrative.det.finding", {
            rank: n.rank,
            indicator: n.indicatorName,
            domain: n.domain,
            subDomain: n.subDomain,
            score: n.severityScore!.toFixed(2),
            band: severityBandLabel(n.severityBand as SeverityBand, locale),
            confidence: confidenceFlagLabel(n.confidence as "LOW" | "STANDARD", locale),
            gapType: n.gapType ?? t("narrative.det.notClassified"),
          }),
        )
        .join(" ")
    : t("narrative.det.noFindings");

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
  // Named `tr`, not `t`: `t` is the THRESHOLDS in this function, and shadowing
  // it with a translator here would silently break every threshold reference.
  const tr = translator(currentLocale());

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
      ? tr("calc.priorityNotCalculable")
      : // The working itself stays symbolic — "Σ ... = 66.67" is arithmetic a
        // reader checks against the figures, not prose to translate. Only the
        // sentence around it is language-dependent.
        `Σ${assessedWeightSum ? ` / ${assessedWeightSum.toFixed(2)}` : ""} = ${priorityScore.toFixed(2)}`,
  );

  return {
    needsIndexFormula: tr("calc.needsIndexFormula"),
    needsIndexWorking,
    priorityScoreFormula: tr("calc.priorityScoreFormula"),
    priorityScoreWorking,
    severityBandingRule: tr("calc.severityBandingRule"),
    confidenceRule: tr("calc.confidenceRule", {
      minSample: t.confidenceMinSample,
      dkThreshold: (t.dontKnowLowThreshold * 100).toFixed(0),
    }),
    equityRule: tr("calc.equityRule", {
      spread: t.equitySpreadThreshold,
      minGroup: t.equityMinGroupN,
    }),
    gapTypeRule: gapTypeBasis(t),
    thresholds: t,
  };
}
