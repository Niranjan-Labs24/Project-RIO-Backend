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
  dontKnowRate: number; // percentage, e.g. 12.4
}

/** One row of severity.domains[] — sourced from VillagePriorityAssessment
 *  .domainComponents joined with ScoreRollup (DOMAIN) for confidence/counts. */
export interface DomainComponent {
  name: string;
  severityScore: number;
  performanceScore: number;
  weight: number;
  weightedContribution: number;
  confidence: ConfidenceLevel;
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
    priorityScore: number;
    priorityStatus: PriorityStatus;
    needCount: number;
  }>;
  aiSummary: AiSummaryBlock;
  demographics: Demographics | null;
  filters: Record<string, unknown>;
}

export interface ExecutiveReportContent {
  header: ReportHeader;
  topPriorities: TopKpi[];
  responseQuality: ResponseQuality;
  aiSummary: AiSummaryBlock;
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
