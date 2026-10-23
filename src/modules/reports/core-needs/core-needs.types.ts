// Core Needs Report (RPT18) — the stored content contract.
//
// Language-neutral by design: codes, numbers and names only, no sentences.
// Every fixed wording is composed at render time from the shared label
// catalogue (frontend messages -> app.reports.content.core), so the same
// stored report reads in English or Arabic in the app, the PDF and Excel.
// Names (domains, KPIs, governorates) are stored in English and translated on
// the way out like every other report (master-data aliases); free text
// (villages, the study title) goes through the live translation.

import type { ConfidenceResult, CoreDecision } from "./core-needs.config";
import type { GapType, SeverityBand } from "../need-record.types";
import type { RespondentUnit } from "./compute-unit-rollups";

export type ScopeLevel = "KINGDOM" | "REGION" | "GOVERNORATE" | "CENTRE" | "VILLAGE";
export const SCOPE_LEVELS: readonly ScopeLevel[] = ["KINGDOM", "REGION", "GOVERNORATE", "CENTRE", "VILLAGE"];

export type CoreOutput = "FULL" | "SUMMARY";

/** The unit a coverage or distribution figure counts. */
export type UnitKind = "REGION" | "GOVERNORATE" | "CENTRE" | "VILLAGE";

export interface CoreNeedsHeader {
  /** NCNP report: owned by the platform, built from several organisations. */
  isNcnp?: boolean;
  studyName: string;
  organizationName: string | null;
  scopeLevel: ScopeLevel;
  /** The selected unit's own name (English master-data name, or the village
   *  as typed). Null at Kingdom level. */
  unitName: string | null;
  /** Parent names for the location line, outermost first. */
  parents: string[];
  domains: Array<{ key: string; name: string }>;
  allDomains: boolean;
  collectedFrom: string | null; // ISO date
  collectedTo: string | null;
  /** NeedSource values of the study's needs (manual_entry, field_survey, …). */
  collectionSources: string[];
  /** The survey's own selection approach, as entered. */
  selectionApproach: string | null;
  methodologyVersion: string;
  generatedAt: string;
}

export interface AreaFigures {
  population: number | null;
  growthRatePct: number | null;
  densityPerKm2: number | null;
  malePct: number | null;
  femalePct: number | null;
  saudiPct: number | null;
  ruralPct: number | null;
  source: string;
  year: number;
}

export interface CoreNeedsProfile {
  /** Null until the platform team has entered figures for this unit. */
  figures: AreaFigures | null;
  /** "In this study: x of N governorates · x of N villages surveyed". */
  governorates: { inStudy: number; total: number | null } | null;
  villages: { withData: number; named: number };
  /** Governorate scope: its centres with data, of all its centres — said
   *  instead of villages when the study names none. */
  centres?: { withData: number; total: number | null } | null;
}

/**
 * A breakdown of the v5.0 methodology's existing confidence flag, not a new
 * scoring model (client, 15 Oct 2026). Each component meets the standard or is
 * LOW; the overall result is LOW when any component is LOW — the same outcome
 * as the methodology's single flag, with the reason shown.
 */
export interface ConfidenceComponents {
  overall: ConfidenceResult;
  /** LOW below the methodology minimum, or below the required sample. */
  sample: { valid: number; required: number | null; minimum: number; result: ConfidenceResult };
  /** v5.0 defines no threshold: shown descriptively and only counted once a
   *  value is approved (`thresholdPct`), so `result` is null until then. */
  coverage: {
    unitKind: UnitKind;
    withData: number;
    total: number;
    largest: { unit: string; sharePct: number } | null;
    concentration: "CONCENTRATED" | "FULLY_CONCENTRATED" | null;
    thresholdPct: number | null;
    result: ConfidenceResult | null;
  };
  /** LOW when the "don't know" share is above the methodology limit. */
  completeness: { validRatePct: number; dontKnowPct: number; dontKnowLimitPct: number; result: ConfidenceResult };
}

export interface CoreSummary {
  needsIndex: number | null;
  needsIndexBand: SeverityBand | null;
  topDomain: { key: string; name: string; score: number } | null;
  /** Up to three findings stated as numbers. */
  findings: Array<{ kpi: string; actual: ActualValue | null; severity: number }>;
  otherDomains: Array<{ key: string; name: string; score: number }>;
  villagesWithData: string[];
  unitsWithoutData: string[];
  decision: CoreDecision;
}

/**
 * The actual value shown beside a severity (client, 15 Oct 2026): the share
 * whose need is not fully met (any answer with a severity above 0), with the
 * share at full severity — the "No" answer — in brackets. "Don't know" is not
 * in the base; `n` is. Numeric questions show the median.
 */
export type ActualValue =
  | {
      kind: "PCT";
      notMetPct: number;
      noPct: number;
      n: number;
      unit?: RespondentUnit;
      /** False when the question has no "No" answer, so no bracket is shown.
       *  Absent on reports generated before 22 Oct 2026 (shown as before). */
      hasNo?: boolean;
    }
  | { kind: "MEDIAN"; value: number; n: number };

export interface GeographyUnit {
  id: string;
  /** KSA geographic reference code — the key of the map boundary. */
  code: string | null;
  name: string;
  villagesWithData: number;
  villagesNamed: number;
  households: number;
  /** From the unit's entered population (Cochran + FPC); null when none. */
  required: number | null;
  needsIndex: number | null;
  /** Centres of the unit with data, out of its centres in the geographic
   *  reference — the interim coverage unit until village master data exists.
   *  Null for units that are not governorates. */
  centresWithData: number | null;
  centresTotal: number | null;
  /** SHOWN, NOT_SHOWN (an approved minimum share is not met) or NO_DATA. */
  scoreStatus: "SHOWN" | "NOT_SHOWN" | "NO_DATA";
  measuredDomains: string[];
  confidence: ConfidenceResult | null;
}

export interface CoreGeography {
  /** False when the scope has a single unit, so the section is hidden. */
  show: boolean;
  unitKind: UnitKind;
  /** Ids drawn on the map (governorates for region scope, etc.). */
  mapLevel: "REGION" | "GOVERNORATE" | "CENTRE" | null;
  units: GeographyUnit[];
  /** Every unit at the map level inside the scope (light = not in study). */
  mapContext: Array<{ code: string; name: string }>;
  /** `order`: the units ranked (meeting the standard, same domains);
   *  `excludedLow`: units with data left out because their result is Low. */
  ranking: { ranked: boolean; order: string[]; excludedLow?: string[] };
  /** Approved minimum share of a unit's centres for its score; null = none. */
  scoreThresholdPct: number | null;
}

export interface CoreVillageRow {
  name: string;
  governorate: string | null;
  population: number | null;
  needsIndex: number | null;
  needsIndexBand: SeverityBand | null;
  priorityScore: number | null;
  priorityStatus: "HIGH" | "MEDIUM" | "LOW" | null;
  responses: number;
  confidence: ConfidenceResult;
}

export interface CoreRankedNeed {
  rank: number;
  kpiCode: string;
  /** The KPI as the methodology names it, code included ("HLT-01 — …") —
   *  the form the Arabic master-data names are keyed on. */
  kpi: string;
  domain: string;
  subDomain: string;
  where: string[];
  actual: ActualValue | null;
  severity: number;
  band: SeverityBand | null;
  /** From the need behind the KPI's answers; null when they disagree.
   *  Absent on reports generated before 22 Oct 2026. */
  gapType?: GapType | null;
}

export interface CoreDomainRow {
  key: string;
  name: string;
  severity: number | null;
  weight: number | null;
  band: SeverityBand | null;
  /** A KPI in this domain is at or above the Critical threshold (v5.0
   *  no-masking rule). Absent on reports generated before 23 Oct 2026. */
  criticalNeedPresent?: boolean;
}

export interface CoreHierarchyKpi {
  code: string;
  name: string;
  actual: ActualValue | null;
  severity: number | null;
  band: SeverityBand | null;
  gapType: GapType | null;
  /** The target group of the survey(s) the KPI comes from. */
  targetGroup: string | null;
  /** Fit to publish for this KPI (Jagan, 19 Oct 2026): its own valid
   *  responses against the required sample, with the report's coverage and
   *  completeness results; null when not measured. */
  fit: "FIT" | "PRELIMINARY" | null;
}
export interface CoreHierarchyIndicator {
  name: string;
  kpis: CoreHierarchyKpi[];
}
export interface CoreHierarchySubDomain {
  name: string;
  severity: number | null;
  indicators: CoreHierarchyIndicator[];
}
export interface CoreHierarchyDomain {
  key: string;
  name: string;
  severity: number | null;
  subDomains: CoreHierarchySubDomain[];
}

/** Only the indicator pairs held in the methodology configuration are
 *  analysed (client, 15 Oct 2026); none configured = the section is hidden. */
export interface CoreLinks {
  pairsConfigured: number;
  minPerGroup: number;
  items: Array<{
    kpiA: string;
    kpiB: string;
    /** Below the minimum per group: "Insufficient data for analysis". */
    sufficient: boolean;
    pctWithA: number;
    pctWithoutA: number;
    nA: number;
    nWithoutA: number;
  }>;
}

export interface CoreEvidence {
  distribution: Array<{ unit: string; parent: string | null; n: number; sharePct: number }>;
  concentration: "CONCENTRATED" | "FULLY_CONCENTRATED" | null;
  /** Approved concentration threshold; null = the share is only stated. */
  concentratedFromPct: number | null;
  responses: {
    submitted: number;
    valid: number;
    duplicate: number;
    lowConfidence: number;
    incomplete: number;
    answersExcluded: number;
    /** Responses excluded as outside the study geography (registration pick). */
    outsideGeography?: number;
    totalAnswers: number;
    dontKnowPct: number;
    dontKnowLimitPct: number;
  };
  gender: { male: number; female: number; unspecified: number };
  age: Array<{ band: string; count: number }>;
  fitToPublish: Array<{
    key: string;
    name: string;
    status: "FIT" | "PRELIMINARY" | "NOT_MEASURED";
    valid: number;
    required: number | null;
    unitsWithData: number;
    unitsTotal: number;
  }>;
  collectNext: Array<
    | { kind: "MORE_HOUSEHOLDS"; count: number; where: string }
    | { kind: "UNITS_WITHOUT_DATA"; units: string[] }
    | { kind: "MORE_VILLAGES"; where: string }
    | { kind: "UNMEASURED_DOMAINS"; count: number }
    | { kind: "AGE_BANDS" }
  >;
}

export interface CoreNeedCard {
  kpi: string;
  domain: string;
  location: string[];
  beneficiaries: { pct: number; population: number; people: number } | null;
  evidence: { valid: number; required: number | null; villages: number; result: ConfidenceResult };
  otherOrganisations: string[];
  eligible: boolean;
}

export interface CoreReading {
  requiredSample: number | null;
  population: number | null;
  marginOfErrorPct: number | null;
  minimumDetectableEffect: number | null;
}

export interface CoreNeedsContent {
  kind: "CORE_NEEDS";
  version: 2;
  output: CoreOutput;
  header: CoreNeedsHeader;
  profile: CoreNeedsProfile;
  confidence: ConfidenceComponents;
  summary: CoreSummary;
  geography: CoreGeography;
  villages: CoreVillageRow[];
  /** Villages left out of the list for having fewer valid responses than
   *  the methodology minimum (client, 15 Oct 2026). */
  villagesBelowMinimum: number;
  rankedNeeds: CoreRankedNeed[];
  domains: CoreDomainRow[];
  hierarchy: CoreHierarchyDomain[];
  /** Combined (NCNP) report only: KPIs whose questions or scoring differ
   *  between the studies' methodology versions, shown separately per version. */
  methodologySplit?: Array<{ kpi: string; versions: string[] }>;
  /** The target group, shown once (client, 15 Oct 2026); in a report that
   *  combines surveys every KPI also carries its own. */
  targetGroup: string | null;
  reading: CoreReading;
  links: CoreLinks;
  evidence: CoreEvidence;
  needCards: CoreNeedCard[];
  /** The v5.0 priority tiers the report was coloured with (methodology
   *  configuration at generation time). */
  tiers: { critical: number; high: number; medium: number };
  /** The selection the user made, for regeneration and the audit trail. */
  filters: Record<string, unknown>;
  /** NCNP report only: the studies combined, each with its reliability. */
  studies?: import("./ncnp-needs").NcnpStudyReliability[];
}

export function isCoreNeedsContent(c: unknown): c is CoreNeedsContent {
  return typeof c === "object" && c !== null && (c as { kind?: unknown }).kind === "CORE_NEEDS";
}

/** Content stored before the 15 Oct 2026 rules (three confidence bands)
 *  cannot be drawn by the current view; it is regenerated instead. */
export function isCurrentCoreNeedsContent(c: unknown): c is CoreNeedsContent {
  return isCoreNeedsContent(c) && (c as { version?: unknown }).version === 2;
}
