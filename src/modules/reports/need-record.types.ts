// The Unified Need Record — the cross-report atom.
//
// RPT01 (Individual Survey Report) is the first consumer, but the shape is
// deliberately written for all four report types the client specified (survey,
// uploaded-documents, merged, NCNP compiled). Deriving it once here is what
// stops the four reports disagreeing about the same need.
//
// Two fields exist here but are ALWAYS null for a survey source, by design:
// `supportingText` and `mergedWith`. Keeping them in the shape now means the
// Merged Report can populate them later without a schema change, and the
// invariant test can assert a survey record never carries them.

/** Cross-report source taxonomy. RPT01 only ever emits 'survey'. */
export type SourceType = "survey" | "qualitative_evidence";

/** Client-specified vocabulary — Acute / Structural / Seasonal / Chronic / Inequality. */
export type GapType = "acute" | "structural" | "seasonal" | "chronic" | "inequality";

export type ConfidenceFlag = "STANDARD" | "LOW";

export type SeverityBand = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** Dimensions the equity flag can compare across. Only these three exist on
 *  SurveyResponse today — no age band, no disability status, so the methodology
 *  cannot ask for either without a citizen-form change. */
export type EquityDimension = "gender" | "settlement_type" | "village";

/**
 * Every threshold the client's spec implies, in one place.
 *
 * These were magic numbers spread across three files. Centralising them means a
 * report can print the trip point it actually used next to the finding, and a
 * methodology change is a config change rather than a code change. The eventual
 * home is a per-methodology-version row (MethodologyThresholdConfig); until that
 * migration lands, DEFAULT_THRESHOLDS below is the single source.
 */
export interface Thresholds {
  /** Valid responses below this → LOW confidence. */
  confidenceMinSample: number;
  /** Don't-know rate above this (0-1 fraction) → LOW confidence. */
  dontKnowLowThreshold: number;
  /** Severity spread (max − min) across groups at/above which equity trips. */
  equitySpreadThreshold: number;
  /** Every compared group must have at least this many valid responses. */
  equityMinGroupN: number;
  /** Pattern analysis is suppressed below this many valid responses. */
  patternMinResponses: number;
  /** …or below this many assessed domains. */
  patternMinDomains: number;
  /** Severity at/above which a gap is 'acute'. */
  acuteSeverityFloor: number;
  /** Severity at/above which, sustained across two cycles, a gap is 'chronic'. */
  chronicSeverityFloor: number;
}

/**
 * Methodology v1.0 defaults. Mirrors the values the scoring pipeline already
 * hard-codes (`validCount < 10 || dontKnowRate > 0.20` in RollupService), so
 * moving to a config table cannot silently change a published score.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  confidenceMinSample: 10,
  dontKnowLowThreshold: 0.2,
  equitySpreadThreshold: 15,
  equityMinGroupN: 5,
  patternMinResponses: 30,
  patternMinDomains: 3,
  acuteSeverityFloor: 70,
  chronicSeverityFloor: 50,
};

/** Canonical geography for a need record — resolved once, used everywhere, so
 *  the header and the narrative cannot name different places. */
export interface UnitGeo {
  regionId: string | null;
  regionName: string | null;
  governorateIds: string[];
  governorateNames: string[];
  centerIds: string[];
  centerNames: string[];
  villages: string[];
  /** Human label, e.g. "Al-Badai, Al-Qassim — all villages (consolidated)". */
  scopeLabel: string;
}

/** Audit Trail requirement — every record traceable to its origin. */
export interface SourceRef {
  kind: "survey_rollup";
  surveyId: string;
  surveyTitle: string;
  studyId: string;
  rollupLevel: "KPI";
  rollupEntityId: string;
  methodologyVersionId: string;
  methodologyVersionLabel: string;
  snapshotId: string;
  assessmentCycle: number;
  calculatedAt: string;
}

interface EquityDetailCommon {
  /** Dimensions that had ≥2 comparable groups in the data. */
  dimensionsAvailable: EquityDimension[];
  /** Dimensions with no segment data at all — states what was NOT checked. */
  dimensionsMissing: EquityDimension[];
}

/**
 * A group comparison that was computed but did NOT clear the minimum group
 * size. The numbers are real measurements, kept so a small-sample report can
 * show what was actually observed instead of printing nothing at all. They are
 * never asserted as an equity finding — `equityFlag` stays false.
 *
 * Groups of a single respondent are excluded: a one-person "group" severity is
 * that person's own answer, and printing it beside a named settlement or gender
 * would identify them.
 */
export interface ObservedComparison {
  dimension: EquityDimension;
  /** Only groups with n ≥ 2, worst severity first. */
  groups: Array<{ label: string; severityScore: number; n: number }>;
  /** max − min across `groups` (the shown groups, so the arithmetic checks out). */
  spread: number;
  /** How many groups were withheld as single-respondent — stated, not hidden. */
  singleRespondentGroupsOmitted: number;
}

/** No dimension cleared the minimum group size. `equityFlag` is false, but the
 *  reason says the sample was too small — a false must never read as
 *  "no inequity found". */
export interface EquityNotEvaluable extends EquityDetailCommon {
  evaluable: false;
  reason: string;
  /** What the comparison would have shown, at sub-threshold sample sizes. */
  observedComparisons: ObservedComparison[];
}

export interface EquityEvaluated extends EquityDetailCommon {
  evaluable: true;
  reason: null;
  /** The dimension with the widest spread — the variance a reader must act on. */
  dimension: EquityDimension;
  groups: Array<{ label: string; severityScore: number; n: number }>;
  /** max − min. */
  spread: number;
  /** The configured trip point, printed alongside so the finding is checkable. */
  threshold: number;
  mostDisadvantaged: string;
}

export type EquityDetail = EquityNotEvaluable | EquityEvaluated;

/**
 * THE unified need record. One row per scored methodology KPI for a survey
 * source; one row per extracted need for a qualitative source.
 *
 * Invariants enforced by rpt01-invariants.spec.ts:
 *   sourceType === 'survey'               → supportingText === null
 *   severityScore === null                → notMeasuredReason !== null
 *   sourceRef                             → always present
 */
export interface NeedRecord {
  /** Deterministic: `NR-survey-{sha256(surveyId|indicatorId|villageScope)[0..12]}`.
   *  Stable across regenerations so a Merged Report's `mergedWith` can reference
   *  it later without a lookup table. */
  needId: string;
  sourceType: SourceType;

  // ── Classification (methodology hierarchy) ──
  domain: string;
  domainKey: string;
  subDomain: string;
  subDomainKey: string;
  indicatorId: string;
  indicatorName: string;
  kpiCode: string;
  kpiName: string;

  // ── Measurement ──
  /** 0–100, higher = worse. NULL when not measurable — NEVER 0 as a stand-in. */
  severityScore: number | null;
  severityBand: SeverityBand | null;
  confidence: ConfidenceFlag;
  /** Names only the condition that actually fired (sample size vs don't-know). */
  confidenceReason: string;
  validResponseCount: number;
  excludedResponseCount: number;
  dontKnowRate: number;
  /** Required whenever severityScore is null. */
  notMeasuredReason: string | null;

  // ── Classification flags ──
  gapType: GapType | null;
  equityFlag: boolean;
  /** Always present — carries the variance when flagged, and why the check could
   *  not run when not. */
  equityDetail: EquityDetail;

  // ── Cross-source fields (always null in RPT01, by design) ──
  supportingText: null;
  mergedWith: null;

  /**
   * People this need affects — the client's Top-Priority column.
   *
   * Sourced from `Need.affectedPopulation`: the estimate the field researcher
   * gives when recording the need, in answer to the need-entry question
   * "Roughly how many people does this need affect?" (client-confirmed Option
   * A, 24 Aug 2026). Reached via `Survey.needId` — see
   * `Rpt01ReferenceData.sourceNeedAffectedPopulation`.
   *
   * NEVER `Study.population`. That is one number for the whole study area (it
   * sizes the sample); writing it here would state that every need affects the
   * entire population, which is a different and false claim.
   *
   * Null in two cases, both of which print "—" with the reason stated beneath
   * the table: the question wasn't answered, and every Need recorded before it
   * was asked. The estimate cannot be reconstructed after the fact, so old
   * needs stay blank unless someone revisits them.
   *
   * Granularity, stated because the column cannot state it itself: a survey's
   * records are indicator-level breakdowns of ONE source need, so every record
   * from a given survey carries that need's single figure. It is the need's
   * reach, not each indicator's.
   */
  affectedPopulation: number | null;

  // ── Provenance (Audit Trail: source_ref always present) ──
  unitGeo: UnitGeo;
  sourceRef: SourceRef;
}
