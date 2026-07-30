import type { ConfidenceFlag, NeedRecord, Thresholds, UnitGeo } from "./need-record.types";
import type { ExecutiveSummaryBlock } from "./providers/compose-executive-summary";
import type { HierarchyDomain } from "./providers/build-need-hierarchy";
import type { PatternAnalysisBlock } from "./providers/compose-pattern-analysis";
import type { DataQualityNotesBlock } from "./providers/compose-data-quality-notes";
import type { RankedNeed } from "./providers/rank-priority-needs";

// The Unified Narrative Report Structure — the six fixed sections the client
// specified, applied to RPT01.
//
// 1 Study Data · 2 Executive Summary · 3 Needs by Domain (domain → sub-domain →
// indicator) · 4 Pattern & Intersection Analysis · 5 Priority Needs ·
// 6 Data Quality Notes (mandatory, rendered even when empty).
//
// Sections 1 and the identity/coverage blocks already exist on
// IndividualSurveyReportContent (`survey`, `coverage`, `header`), so this adds
// sections 2–6 plus the machine-readable `needRecords` payload the Merged and
// NCNP reports will consume. Written as its own interface so the other three
// report types can implement the same six sections without copying the shape.

export interface ReportMeta {
  reportType: "RPT01";
  reportTypeName: "Individual Survey Report";
  /** Cover badge — this report rests on survey responses and nothing else. */
  sourceBasis: "SURVEY_ONLY";
  isQuantitative: true;
  /** 'measured' here; the uploaded-documents report is 'always_null'. */
  severityScorePolicy: "measured";
  contentVersion: 2;
  generatedAt: string;
}

export interface VillagePriorityBlock {
  priorityScore: number | null;
  priorityStatus: "HIGH" | "MEDIUM" | "LOW" | null;
  /** Set whenever priorityScore is null — never a 0 or a 'LOW' stand-in. */
  notCalculableReason: string | null;
  overrideApplied: boolean;
  overrideReason: string | null;
  /** Which domains the score was computed over, and how it was normalised. */
  coverageBasis: string;
  /** Severity and priority run in opposite directions; this says so on the page. */
  scoreDirectionNote: string;
}

export interface PriorityNeedsBlock {
  /** Human-readable formula — the ranking must be reproducible by a reader. */
  rankingBasis: string;
  needs: RankedNeed[];
  villagePriority: VillagePriorityBlock;
  /** severityScore === null. Ranked out, listed explicitly rather than dropped. */
  notMeasured: NeedRecord[];
}

/** Prints the arithmetic with this report's own numbers, so a reader can
 *  recompute both headline figures instead of taking them on trust. */
export interface CalculationBasisBlock {
  needsIndexFormula: string;
  needsIndexWorking: string[];
  priorityScoreFormula: string;
  priorityScoreWorking: string[];
  severityBandingRule: string;
  confidenceRule: string;
  equityRule: string;
  gapTypeRule: string;
  thresholds: Thresholds;
}

/** Sections 2–6 of the Unified Narrative Report Structure, plus provenance. */
export interface UnifiedRpt01Sections {
  reportMeta: ReportMeta;
  /** Canonical geography — one resolver feeds header, narrative and coverage. */
  unitGeo: UnitGeo;
  executiveSummary: ExecutiveSummaryBlock;
  needsByDomain: HierarchyDomain[];
  patternAnalysis: PatternAnalysisBlock;
  priorityNeeds: PriorityNeedsBlock;
  dataQualityNotes: DataQualityNotesBlock;
  calculationBasis: CalculationBasisBlock;
  /** Flat list of every record above — the payload the Merged and NCNP reports
   *  consume. Always equal in length to the nested hierarchy's records. */
  needRecords: NeedRecord[];
}

export type { ConfidenceFlag, HierarchyDomain, PatternAnalysisBlock, DataQualityNotesBlock, ExecutiveSummaryBlock };
