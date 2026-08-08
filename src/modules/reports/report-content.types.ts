// Report content contract — the shape every core-report generator emits and
// the shape the frontend viewer renders. Single source of truth for both.
//
// These types mirror the team's AI-summary mock (RPT-2026-001). They are
// produced by the ReportDataProvider seam (see providers/report-data.provider.ts),
// implemented by ReportSummaryDataProvider against real analytics tables —
// the mock implementation (MockReportDataProvider/MockReportApiClient) has
// been removed now that the real provider is in place. "Body changes,
// contract doesn't."

import type { UnifiedRpt01Sections } from "./unified-report.types";

/** Confidence banding carried through from ScoreRollup.confidenceLevel. */
export type ConfidenceLevel = "LOW" | "STANDARD";

/** Default per-domain trend note when only one assessment cycle exists — no
 *  prior cycle to compare against. Kept as a shared constant so the mapper and
 *  tests agree, and so a real per-domain AI trend note can replace it later
 *  without another schema change. */
export const SINGLE_CYCLE_TREND_NOTE =
  "Trends cannot be assessed from a single assessment cycle.";

/** Placeholder shown in the first-class Data Quality Note field when the AI
 *  narrative didn't supply one — every report carries the field so the column
 *  is consistent across report types (never blank/absent). */
export const DATA_QUALITY_NOTE_UNAVAILABLE =
  "Data quality note not available for this assessment.";

/** HIGH | MEDIUM | LOW — from VillagePriorityAssessment.priorityStatus. */
export type PriorityStatus = "HIGH" | "MEDIUM" | "LOW";

/** Header band shown at the top of every export (org/entity + provenance). */
export interface ReportHeader {
  studyName: string;
  entityName: string | null;
  methodologyVersion: string;
  reportGeneratedAt: string; // ISO-8601
}

export interface VillageIdentity {
  id: string;
  name: string;
  assessmentCycle: number;
  assessmentPeriod: string; // human-readable window, e.g. "01 July 2026 - 15 July 2026"
}

export interface ResponseQuality {
  submittedResponses: number;
  validResponses: number;
  overallConfidence: ConfidenceLevel;
  // Why the confidence band is what it is — names the condition that actually
  // fired (sample size vs don't-know rate), never both when only one did.
  confidenceReason: string;
  // The valid-response ratio (validResponses / submittedResponses × 100),
  // rounded. This is a DATA COMPLETENESS figure, not a confidence percentage:
  // rendering it as "STANDARD (90%)" implied the band was 90% certain, which is
  // a different claim and the source of the client's confidence objection. The
  // two are now separate fields and are rendered as separate rows.
  validResponseRatePct: number;
  dontKnowRate: number; // percentage, e.g. 12.4
  // Backend-decided adjective for the don't-know rate. The prompt must use it
  // verbatim rather than characterising the number itself.
  dontKnowBand: "negligible" | "moderate" | "elevated" | "high";
  // RIO-FR-024: the study's own signed-off sample-size target (Cochran +
  // finite population correction), computed once at study creation — see
  // StudiesService/sample-size.ts. Null for studies created before this
  // field existed, in which case the dual confidence criterion falls back
  // to the absolute floor alone (see severity-bands.ts's confidenceFlagOf).
  population: number | null;
  requiredSampleSize: number | null;
  minimumDetectableEffect: number | null;
}

/** One row of severity.domains[] — sourced from VillagePriorityAssessment
 *  .domainComponents joined with ScoreRollup (DOMAIN) for confidence/counts. */
export interface DomainComponent {
  name: string;
  // Methodology domain key/code (e.g. "WATER_SANITATION") — lets a reader map
  // the row back to the methodology's indicators. Sourced from ScoreRollup
  // .entityId / Domain.code.
  domainCode: string;
  // NULL when this domain was not measurable — never 0 as a stand-in. A 0 here
  // reads as "assessed, no problem found", the opposite of the truth.
  severityScore: number | null;
  performanceScore: number | null;
  weight: number | null;
  weightedContribution: number | null;
  confidence: ConfidenceLevel;
  // Why the band is what it is — see ResponseQuality.confidenceReason.
  confidenceReason: string;
  // Data completeness, kept distinct from the confidence band (see above).
  validResponseRatePct: number;
  // Number of methodology KPIs defined under this domain (i.e. the KPIs that
  // contribute to its severity). Counted from the methodology's Question set.
  kpiCount: number;
  // Per-domain trend note. Defaults to SINGLE_CYCLE_TREND_NOTE until multiple
  // assessment cycles exist (or a real per-domain AI note is produced).
  trendNote: string;
  isCriticalDomain: boolean;
  // Present only for low-confidence domains (drives the data-quality note).
  validResponseCount?: number;
  dontKnowRate?: number;
}

export interface SeverityBlock {
  // NULL when nothing could be scored. Renderers print "—", never 0.
  overallVillageNeedsIndex: number | null;
  label: string; // "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNSCORED"
  domains: DomainComponent[];
}

export interface PriorityBlock {
  // NULL when no priority assessment is stored. The old `0` + `'LOW'` fallback
  // contradicted the banding itself (≤40 → HIGH), so an unscored village was
  // reported as the lowest-priority one.
  villagePriorityScore: number | null;
  priorityStatus: PriorityStatus | null;
  /** Required whenever villagePriorityScore is null. */
  notCalculableReason: string | null;
  overrideApplied: boolean;
  overrideReason: string | null;
}

export interface TopKpi {
  rank: number;
  kpi: string;
  domain: string;
  severityScore: number | null;
  confidence: ConfidenceLevel;
  validResponseCount: number;
  /** Present when severityScore is null — why it could not be measured. */
  notMeasuredReason?: string | null;
}

export interface QualitativeEvidenceItem {
  theme: string;
  summary: string;
}

/** AI-narrative block — flows through the provider's AI seam. Mock text now,
 *  real LLM later, same shape. */
export interface AiSummaryBlock {
  executiveSummary: string;
  keyFindings: string;
  dataQualityNote: string;
  trendNote: string;
  recommendations: string[];
}

// ──────── Survey-scoped reports (RPT01 / RPT15) ────────

/** Identity band for a report generated from ONE survey, as opposed to a whole
 *  study. Answers "which survey, under which need, covering where, when". */
export interface SurveyIdentity {
  surveyId: string;
  surveyTitle: string;
  surveyStatus: string;
  needStatement: string;
  needStatus: string;
  villageName: string;
  assessmentCycle: number;
  assessmentPeriod: string;
  /** Snapshot taken at publish time — never a live methodology reference. */
  methodologyVersion: string | null;
  publishedAt: string | null; // ISO-8601
}

/** Survey-level volume/coverage counts. Every field is a real count; an empty
 *  study reports honest zeros rather than omitting the tile, so the band keeps
 *  the same shape across reports. Built by providers/coverage-counts.ts. */
export interface CoverageBlock {
  studyTitle: string;
  studyCycleNumber: number;
  needsInStudy: number;
  /** Always 1 — a Survey belongs to one Need. Rendered as "1 of N". */
  needsCoveredByThisSurvey: number;
  surveysInStudy: number;
  villagesCovered: number;
  villageNames: string[];
  governoratesCovered: number;
  centersCovered: number;
  surveyQuestionsTotal: number;
  surveyQuestionsFromBank: number;
  surveyQuestionsCustom: number;
  publicSurveyLinks: number;
  activeSurveyLinks: number;
  responsesSubmitted: number;
  responsesValid: number;
  responsesExcluded: number;
  dontKnowRatePct: number;
  duplicateResponses: number;
  lowConfidenceResponses: number;
  evidenceFilesTotal: number;
  evidenceIncludedInReport: number;
  domainsScored: number;
  /** KPI rollups that exist for this survey — i.e. KPIs it asked about. */
  kpisAttempted: number;
  /** KPI rollups that produced an actual severity. Always ≤ kpisAttempted. */
  kpisScored: number;
  /** kpisAttempted − kpisScored. Counted and shown, never folded into "scored". */
  kpisNotMeasurable: number;
  assessmentPeriod: string;
}

/** Organisation-wide volume counts — RPT15 only. Org-scoped, never cross-org. */
export interface PortfolioBlock {
  studiesTotal: number;
  needsTotal: number;
  needsByStatus: Array<{ label: string; count: number }>;
  surveysTotal: number;
  surveysByStatus: Array<{ label: string; count: number }>;
  publicLinksTotal: number;
  responsesTotal: number;
  evidenceFilesTotal: number;
  reportsTotal: number;
  reportsByStatus: Array<{ label: string; count: number }>;
  sharingRequestsTotal: number;
  sharingRequestsByStatus: Array<{ label: string; count: number }>;
  villagesCovered: number;
  governoratesCovered: number;
  /** How much of the org's total field data this one survey represents. */
  thisSurveyShareOfResponsesPct: number;
}

/** One step of the data-collection funnel — links → submitted → valid → scored.
 *  Rendered as bars so drop-off between stages is visible at a glance. */
export interface FunnelStage {
  stage: string;
  count: number;
}

/** Questions contributing to each domain in this survey — a bar chart that
 *  shows where the questionnaire's weight actually sits. */
export interface DomainCount {
  domain: string;
  count: number;
}

/** One row of RPT15's reconciliation band: this survey against the org-wide
 *  figure for the same metric. `delta` is survey − org. */
export interface ComparisonRow {
  metric: string;
  surveyValue: number;
  orgAverage: number;
  delta: number;
  direction: "above" | "below" | "inline";
}

/** Two-actor audit block — Officer confirms, Reviewer approves (Step 3 fills
 *  the officer fields; null-safe until then). */
export interface ApprovalBlock {
  officerConfirmedBy: string | null;
  officerConfirmedAt: string | null; // ISO-8601
  reviewerApprovedBy: string | null;
  reviewerApprovedAt: string | null; // ISO-8601
}

/** Full Village Report (RPT14) content — deep-equals the RPT-2026-001 mock. */
export interface VillageReportContent {
  header: ReportHeader;
  village: VillageIdentity;
  responseQuality: ResponseQuality;
  severity: SeverityBlock;
  priority: PriorityBlock;
  topKpis: TopKpi[];
  qualitativeEvidence: QualitativeEvidenceItem[];
  aiSummary: AiSummaryBlock;
  // First-class Data Quality and Trend notes (promoted out of aiSummary) so
  // every report carries them as consistent structured fields, not just
  // narrative text. Trend defaults to a placeholder when unavailable.
  dataQualityNote: string;
  trendNote: string;
  approval: ApprovalBlock;
  // Gender/rural breakdown — null until demographic capture ships, which makes
  // the demographic charts render "Not available" (see getDemographics).
  demographics: Demographics | null;
  // Applied dashboard filters snapshotted at generation time — the belt-and-
  // suspenders half of the reconcile guarantee.
  filters: Record<string, unknown>;
}

/** The blocks RPT01 and RPT15 share, built from ONE ReportDataSnapshot.
 *
 *  Deliberately carries `header` + `severity` so it satisfies the `isCore`
 *  predicate in report-doc.ts and report-content-view.tsx, and therefore
 *  inherits the existing gauge / radar / severity-bars / demographics-donut
 *  rendering for free. `coverage`, `responseFunnel` and `questionCoverage` are
 *  the blocks the survey-scoped reports add on top. */
export interface SurveyReportBase {
  header: ReportHeader;
  survey: SurveyIdentity;
  coverage: CoverageBlock;
  responseQuality: ResponseQuality;
  severity: SeverityBlock;
  priority: PriorityBlock;
  topKpis: TopKpi[];
  responseFunnel: FunnelStage[];
  questionCoverage: DomainCount[];
  qualitativeEvidence: QualitativeEvidenceItem[];
  aiSummary: AiSummaryBlock;
  dataQualityNote: string;
  trendNote: string;
  approval: ApprovalBlock;
  demographics: Demographics | null;
  filters: Record<string, unknown>;
}

/** RPT01 Individual Survey Report — one survey, end to end.
 *
 *  The shared survey blocks PLUS the six fixed sections of the Unified
 *  Narrative Report Structure and the flat `needRecords` payload the Merged and
 *  NCNP reports will consume. RPT15 takes only the shared half, which is why
 *  the two are split. */
export interface IndividualSurveyReportContent extends SurveyReportBase, UnifiedRpt01Sections {}

/** RPT15 Survey & Dashboard Report — one survey's results merged with
 *  the organisation's dashboard outputs, plus the band that reconciles them.
 *
 *  Reconciliation rule: `responseQuality` / `severity` / `priority` / `topKpis`
 *  / `demographics` MUST come from the same ReportDataSnapshot that RPT01 uses,
 *  and `dashboard.*` from a single getCollectiveDashboard() call. Recomputing a
 *  figure twice is how the two halves silently drift apart — see the
 *  reconciliation spec. */
export interface CombinedReportContent {
  header: ReportHeader;
  survey: SurveyIdentity;
  coverage: CoverageBlock;
  portfolio: PortfolioBlock;

  // ── Survey half (same shapes as RPT01, same snapshot) ──
  responseQuality: ResponseQuality;
  severity: SeverityBlock;
  priority: PriorityBlock;
  topKpis: TopKpi[];
  responseFunnel: FunnelStage[];
  questionCoverage: DomainCount[];
  demographics: Demographics | null;

  // ── Dashboard half ──
  dashboard: {
    // The survey half is a frozen snapshot; the dashboard is live at generation
    // time. Both stamps are rendered so a reader knows what each half is as-of.
    capturedAt: string;
    kpis: {
      needCount: number;
      slaCompliancePct: number | null;
      slaBreaches: number;
      slaAtRisk: number;
    };
    scoringDistribution: Array<{ band: string; count: number }>;
    topPriorities: Array<{
      rank: number;
      label: string;
      domain: string;
      severityScore: number;
      entity?: string;
    }>;
    trends: Array<{ label: string; direction: "up" | "down" | "flat"; note: string }>;
    anomalies: string[];
    reviewerNotes: Array<{ author: string; note: string; at: string }>;
  };

  /** What makes this "combined" rather than two reports stapled together. */
  comparison: ComparisonRow[];

  aiSummary: AiSummaryBlock;
  dataQualityNote: string;
  trendNote: string;
  approval: ApprovalBlock;
  filters: Record<string, unknown>;
}

// ── Aux shapes for the other core reports (fleshed out in Steps 2 & 5). ──

export interface SectorReportContent {
  header: ReportHeader;
  domains: DomainComponent[];
  overall: SeverityBlock;
  aiSummary: AiSummaryBlock;
  // First-class Data Quality and Trend notes (see VillageReportContent).
  dataQualityNote: string;
  trendNote: string;
  // Gender/rural breakdown — same convention as VillageReportContent's own
  // field: null until demographic capture ships or no matching responses
  // exist, never omitted just because this is a non-Village scope.
  demographics: Demographics | null;
  filters: Record<string, unknown>;
}

export interface RegionReportContent {
  header: ReportHeader;
  regions: Array<{
    regionName: string;
    governorate: string | null;
    needCount: number;
    // Number of valid survey responses that contributed to this region's score.
    responseCount: number;
    // Severity (Needs Index, 0–100) shown alongside the priority score so the
    // two are legible side by side. Null when nothing was scored.
    severityScore: number | null;
    priorityScore: number | null;
    priorityStatus: PriorityStatus | null;
  }>;
  aiSummary: AiSummaryBlock;
  // Data Quality and Trend notes are promoted to first-class report fields for
  // the region report — rendered as their own labeled sections, distinct from
  // the AI Summary narrative. Sourced from the same AI output as aiSummary, but
  // moved out of it (aiSummary's copies are left blank to avoid duplication).
  dataQualityNote: string;
  trendNote: string;
  demographics: Demographics | null;
  filters: Record<string, unknown>;
}

export interface ExecutiveReportContent {
  header: ReportHeader;
  // Structured scope — makes the region/governorate coverage explicit rather
  // than only mentioning "Consolidated Villages" in the narrative.
  scope: {
    villages: string; // e.g. "Consolidated Villages"
    governorate: string | null;
  };
  topPriorities: TopKpi[];
  responseQuality: ResponseQuality;
  aiSummary: AiSummaryBlock;
  // First-class Data Quality and Trend notes (see VillageReportContent).
  dataQualityNote: string;
  trendNote: string;
  anomalies: string[];
  reviewerNotes: string | null;
  demographics: Demographics | null;
  filters: Record<string, unknown>;
}

/** RPT02 Collective Dashboard KPIs — SLA compliance lives here (mock now,
 *  reviewer-sla module later). */
export interface CollectiveKpis {
  needCount: number;
  scoringDistribution: Array<{ band: string; count: number }>;
  slaCompliancePct: number | null; // null until reviewer-sla is wired
}

/** RPT02 Collective Report / Dashboard content — cross-study/entity KPIs +
 *  an executive-summary narrative (top priorities, trends, anomalies). */
export interface CollectiveReportContent {
  header: ReportHeader;
  kpis: { needCount: number; slaCompliancePct: number | null };
  scoringDistribution: Array<{ band: string; count: number }>;
  aiSummary: AiSummaryBlock;
  filters: Record<string, unknown>;
}

/** RPT12 Report Sharing Status — cross-org sharing requests + a status tally.
 *  Real impl reads ReportSharingRequest; the mock returns representative rows. */
export interface SharingStatusContent {
  header: ReportHeader;
  summary: { approved: number; pending: number; rejected: number };
  requests: Array<{
    reportTitle: string;
    requestingOrg: string;
    ownerOrg: string;
    status: string;
    requestedAt: string;
    decidedAt: string | null;
  }>;
  filters: Record<string, unknown>;
}

/** Gender/rural demographics — null until demographic capture ships, which is
 *  what makes the demographic charts degrade to "Not available" (Step 4). */
export interface Demographics {
  gender: Array<{ label: string; count: number }>;
  rural: Array<{ label: string; count: number }>;
}

/** Collective Dashboard aggregate the provider supplies (everything except the
 *  live SLA figures, which the dashboard service overlays from reviewer-sla). */
export interface CollectiveDashboardData {
  needCount: number;
  scoringDistribution: Array<{ band: string; count: number }>;
  topPriorities: Array<{ rank: number; label: string; domain: string; severityScore: number; entity?: string }>;
  trends: Array<{ label: string; direction: "up" | "down" | "flat"; note: string }>;
  anomalies: Array<{ severity: "info" | "warning" | "critical"; note: string }>;
  reviewerNotes: Array<{ author: string; note: string; at: string }>;
}
