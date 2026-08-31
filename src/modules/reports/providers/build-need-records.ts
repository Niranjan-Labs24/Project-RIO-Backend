import { createHash } from "node:crypto";
import type {
  ConfidenceFlag,
  GapType,
  NeedRecord,
  SourceRef,
  Thresholds,
  UnitGeo,
} from "../need-record.types";
import { composeConfidenceReason, severityBandOf } from "./severity-bands";
import { currentLocale } from "../../../tenancy/org-context";
import { deriveEquityFlag, type SegmentRow } from "./derive-equity-flag";
import { deriveGapType } from "./derive-gap-type";

/** A KPI-level ScoreRollup row, narrowed to what a need record needs. */
export interface KpiRollupRow {
  entityId: string;
  entityNameSnapshot: string;
  severityScore: number | null;
  confidenceLevel: string;
  validResponseCount: number;
  excludedResponseCount: number;
  dontKnowCount: number;
  notApplicableCount: number;
  dontKnowRate: number;
}

/** The methodology hierarchy a KPI hangs from, read from the question bank. */
export interface ClassificationRow {
  domain: string;
  domainKey: string;
  subDomain: string;
  subDomainKey: string;
  indicatorId: string;
  indicatorName: string;
  gapTypeHint: GapType | null;
}

/**
 * Deterministic need_id. Stable across regenerations of the same scored data, so
 * the Merged Report's `merged_with` can reference a survey record by id without
 * a lookup table. Keyed on the KPI/indicator entity and the village scope —
 * NOT on the snapshot id, which changes whenever a score moves.
 */
export function surveyNeedId(surveyId: string, indicatorId: string, villageScope: string): string {
  const h = createHash("sha256").update(["survey", surveyId, indicatorId, villageScope].join("|"));
  return `NR-survey-${h.digest("hex").slice(0, 12)}`;
}

/**
 * Explains WHY a severity is null, from the rollup's own status counts.
 * Required whenever severityScore is null — asserted by test.
 *
 * Deliberately does not claim "don't know" unless the don't-know count says so:
 * an indicator can have every answer excluded for an unrelated reason, and the
 * previous blanket wording invented a cause.
 */
export function notMeasuredReason(r: KpiRollupRow): string {
  const parts: string[] = [];
  if (r.dontKnowCount > 0) parts.push(`${r.dontKnowCount} don't-know`);
  if (r.notApplicableCount > 0) parts.push(`${r.notApplicableCount} not-applicable`);
  const other = Math.max(0, r.excludedResponseCount - r.dontKnowCount);
  if (other > 0) parts.push(`${other} excluded for another reason`);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  return `0 valid responses — no answer to this indicator could be scored${detail}.`;
}

export interface BuildNeedRecordsInput {
  kpiRollups: KpiRollupRow[];
  /** Keyed by the KPI rollup's entityId. */
  classificationByIndicator: Map<string, ClassificationRow>;
  segmentsByIndicator: Map<string, SegmentRow[]>;
  priorCycleByIndicator: Map<string, number>;
  unitGeo: UnitGeo;
  sourceRefBase: Omit<SourceRef, "rollupEntityId">;
  thresholds: Thresholds;
  surveyId: string;
  villageScope: string;
  /**
   * The source Need's own affected-population estimate (Survey.needId →
   * Need.affectedPopulation), or null when it was never given.
   *
   * Every record built here is an indicator-level breakdown of that ONE need,
   * so they all carry the same figure — it is the need's reach, not each
   * indicator's. That is a much narrower claim than the study-area population
   * would have made, but it is still not a per-indicator number, and the
   * report says so beneath the table rather than leaving a reader to assume
   * otherwise.
   */
  sourceNeedAffectedPopulation: number | null;
}

export function buildNeedRecords(input: BuildNeedRecordsInput): NeedRecord[] {
  const {
    kpiRollups,
    classificationByIndicator,
    segmentsByIndicator,
    priorCycleByIndicator,
    unitGeo,
    sourceRefBase,
    thresholds,
    surveyId,
    villageScope,
    sourceNeedAffectedPopulation,
  } = input;

  return kpiRollups.map((r) => {
    const cls = classificationByIndicator.get(r.entityId);
    const { equityFlag, equityDetail } = deriveEquityFlag(
      segmentsByIndicator.get(r.entityId) ?? [],
      thresholds,
    );

    const gapType = deriveGapType({
      severityScore: r.severityScore,
      equityFlag,
      priorCycleSeverity: priorCycleByIndicator.get(r.entityId) ?? null,
      gapTypeHint: cls?.gapTypeHint ?? null,
      thresholds,
    });

    const confidence: ConfidenceFlag = r.confidenceLevel.toUpperCase() === "LOW" ? "LOW" : "STANDARD";

    return {
      needId: surveyNeedId(surveyId, r.entityId, villageScope),
      sourceType: "survey",

      // An unmapped KPI lands in an explicit bucket rather than being dropped —
      // a silently missing indicator is indistinguishable from one that scored
      // well, which is the failure mode this avoids.
      domain: cls?.domain ?? "Unmapped Domain",
      domainKey: cls?.domainKey ?? "UNMAPPED",
      subDomain: cls?.subDomain ?? "Unmapped Sub-domain",
      subDomainKey: cls?.subDomainKey ?? "UNMAPPED",
      indicatorId: cls?.indicatorId ?? r.entityId,
      indicatorName: cls?.indicatorName ?? r.entityNameSnapshot,
      kpiCode: r.entityId,
      kpiName: r.entityNameSnapshot,

      // NO `?? 0`. A null severity stays null all the way to the renderer,
      // which prints "—" plus notMeasuredReason.
      severityScore: r.severityScore,
      severityBand: severityBandOf(r.severityScore),
      confidence,
      // In the caller's language. This sentence is quoted VERBATIM by the
      // report prompts and rendered directly into the report, so composing it
      // in English left a full English paragraph in the most-read part of an
      // Arabic report (RIO-I18N-003 §6.1).
      confidenceReason: composeConfidenceReason({
        validResponseCount: r.validResponseCount,
        dontKnowRate: r.dontKnowRate,
        thresholds,
        locale: currentLocale(),
      }),
      validResponseCount: r.validResponseCount,
      excludedResponseCount: r.excludedResponseCount,
      dontKnowRate: r.dontKnowRate,
      notMeasuredReason: r.severityScore === null ? notMeasuredReason(r) : null,

      gapType,
      equityFlag,
      equityDetail,

      // Invariant for a survey source. The Merged Report populates these.
      supportingText: null,
      mergedWith: null,

      // The source Need's own recorded estimate, the same for every indicator
      // of that need — see sourceNeedAffectedPopulation on the input type.
      // Null when it was never answered, never Study.population: that figure
      // covers the whole study area and would read as "this one need affects
      // all of them".
      affectedPopulation: sourceNeedAffectedPopulation,

      unitGeo,
      sourceRef: { ...sourceRefBase, rollupEntityId: r.entityId },
    } satisfies NeedRecord;
  });
}
