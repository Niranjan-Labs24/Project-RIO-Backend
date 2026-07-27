// Report content contract — the shape every core-report generator emits and
// the shape the frontend viewer renders. Single source of truth for both.
//
// These types mirror the team's AI-summary mock (RPT-2026-001). They are
// produced by the ReportDataProvider seam (see providers/report-data.provider.ts):
// today MockReportDataProvider fills them from the mock API; later
// PrismaReportDataProvider fills the identical shapes from real analytics
// tables + real LLM, with no change here, in the generators, or on the
// frontend. "Body changes, contract doesn't."

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
  // Quantitative companion to overallConfidence — valid-response ratio
  // (validResponses / submittedResponses × 100), rounded. Rendered alongside
  // the qualitative band, e.g. "STANDARD (90%)".
  confidencePct: number;
  dontKnowRate: number; // percentage, e.g. 12.4
}

/** One row of severity.domains[] — sourced from VillagePriorityAssessment
 *  .domainComponents joined with ScoreRollup (DOMAIN) for confidence/counts. */
export interface DomainComponent {
  name: string;
  // Methodology domain key/code (e.g. "WATER_SANITATION") — lets a reader map
  // the row back to the methodology's indicators. Sourced from ScoreRollup
  // .entityId / Domain.code.
  domainCode: string;
  severityScore: number;
  performanceScore: number;
  weight: number;
  weightedContribution: number;
  confidence: ConfidenceLevel;
  // Quantitative companion to the qualitative `confidence` band — the valid-
  // response ratio (validResponses / submittedResponses × 100), rounded. The
  // Confidence column renders both, e.g. "STANDARD (82%)".
  confidencePct: number;
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
  overallVillageNeedsIndex: number;
  label: string; // "Low" | "Medium" | "High" (display banding)
  domains: DomainComponent[];
}

export interface PriorityBlock {
  villagePriorityScore: number;
  priorityStatus: PriorityStatus;
  overrideApplied: boolean;
  overrideReason: string | null;
}

export interface TopKpi {
  rank: number;
  kpi: string;
  domain: string;
  severityScore: number;
  confidence: ConfidenceLevel;
  validResponseCount: number;
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
    // two are legible side by side.
    severityScore: number;
    priorityScore: number;
    priorityStatus: PriorityStatus;
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
