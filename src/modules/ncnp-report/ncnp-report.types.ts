// A count for the current window alongside the immediately-preceding window
// of the same length, so "New This Period" always ships with an honest
// baseline instead of a bare, uninterpretable absolute number.
export interface NcnpPeriodStat {
  current: number;
  previous: number;
  // null when previous is 0 — an undefined percentage, not a fabricated one
  // (e.g. "+infinity%"/"+100%" would both misrepresent "went from 0 to N").
  changePct: number | null;
}

export interface NcnpReportSummary {
  totals: {
    organizations: number;
    studies: number;
    surveys: number;
    responses: number;
    needs: number;
  };
  newThisPeriod: {
    periodDays: number;
    organizations: NcnpPeriodStat;
    studies: NcnpPeriodStat;
    surveys: NcnpPeriodStat;
    responses: NcnpPeriodStat;
  };
}

export interface NcnpOrgNeedingAttention {
  organizationId: string;
  organizationName: string;
  // null only for an org with literally no Study/Survey/Response activity
  // ever recorded — distinct from "long ago," which is a real timestamp.
  lastActivity: string | null;
}

export interface NcnpOrgHealth {
  active: number;
  inactive: number;
  dormant: number;
  dormantDays: number;
  needsAttention: NcnpOrgNeedingAttention[];
}

export interface NcnpDomainBreakdown {
  domainCode: string;
  domainName: string;
  needCount: number;
}

export interface NcnpStudyStatus {
  active: number;
  archived: number;
}

// The survey's own workflow status, not the public-link Open/Closed
// concept — see PublicSurveyLink for the latter, deliberately not
// conflated with this one (see the earlier NCNP report design decision).
export interface NcnpSurveyStatus {
  draft: number;
  submitted: number;
  published: number;
  rejected: number;
}

// PublicSurveyLink.isActive, aggregated platform-wide — the citizen-facing
// link's Open (isActive: true) / Closed (isActive: false) state, distinct
// from NcnpSurveyStatus above (the Survey's own approval workflow).
export interface NcnpPublicLinkStatus {
  open: number;
  closed: number;
}

export interface NcnpRegionBreakdown {
  regionId: string;
  regionName: string;
  count: number;
}

export interface NcnpRegionSurveyStatus extends NcnpRegionBreakdown {
  status: NcnpSurveyStatus;
}

export interface NcnpMonthlyPoint {
  month: string; // YYYY-MM
  count: number;
}

export interface NcnpGenderBreakdown {
  gender: string;
  count: number;
}

// ageBracket is the Prisma enum identifier (e.g. "age_15_24",
// "prefer_not_to_say") — the PDF/UI map these to display labels ("15–24").
export interface NcnpAgeBracketBreakdown {
  ageBracket: string;
  count: number;
}

export interface NcnpOrgResponseStat {
  organizationId: string;
  organizationName: string;
  value: number;
}

export interface NcnpResponseAnalytics {
  monthlyTrend: NcnpMonthlyPoint[];
  responsesByRegion: NcnpRegionBreakdown[];
  genderDistribution: NcnpGenderBreakdown[];
  // Only responses that actually have an age bracket recorded — never
  // padded or backfilled for responses collected before this field existed.
  ageBracketDistribution: NcnpAgeBracketBreakdown[];
  // True when at least one SurveyResponse has no ageBracket value (i.e. was
  // collected before this feature went live). The report must disclose this
  // explicitly rather than silently excluding those responses from the
  // breakdown above and letting the reader assume 100% coverage.
  hasResponsesWithoutAgeBracket: boolean;
  topOrgsByTotalResponses: NcnpOrgResponseStat[];
  topOrgsByAvgResponsesPerSurvey: NcnpOrgResponseStat[];
}

// reasonCode is the Prisma enum identifier (e.g. "REJ_01", "REJ_99"), or the
// literal string "UNSPECIFIED" for surveys rejected before this field
// existed — grouped separately rather than dropped, so the breakdown's
// total always reconciles with the real rejected-survey count.
export interface NcnpRejectionReasonBreakdown {
  reasonCode: string;
  count: number;
}

export interface NcnpSurveyAnalytics {
  statusPlatformWide: NcnpSurveyStatus;
  statusByRegion: NcnpRegionSurveyStatus[];
  avgResponsesPerPublishedSurvey: number;
  rejectionReasonBreakdown: NcnpRejectionReasonBreakdown[];
}

export interface NcnpPriorityLevelBreakdown {
  status: string; // HIGH | MEDIUM | LOW, as stored — never re-labeled here
  count: number;
}

export interface NcnpDomainComparison {
  domainKey: string;
  domainName: string;
  avgPerformanceScore: number;
  isCriticalDomain: boolean;
  assessmentCount: number;
}

export interface NcnpVillageScorecard {
  studyId: string;
  surveyId: string;
  villageId: string;
  priorityScore: number;
  priorityStatus: string;
}

export interface NcnpPriorityOverview {
  byStatus: NcnpPriorityLevelBreakdown[];
  domainComparison: NcnpDomainComparison[];
  topPriorityVillages: NcnpVillageScorecard[];
}

export interface NcnpNamedBreakdown {
  id: string;
  name: string;
  count: number;
}

export interface NcnpGeographyOverview {
  organizationsByRegion: NcnpNamedBreakdown[];
  organizationsByGovernorate: NcnpNamedBreakdown[];
  organizationsByCenter: NcnpNamedBreakdown[];
  studiesByRegion: NcnpNamedBreakdown[];
}

// Kingdom-wide rollup of Needs themselves (not organizations, not surveys) —
// by region/governorate/center. A Need can span more than one governorate/
// center (multi-select), so a single Need can contribute to more than one
// bar here — same fan-out-when-genuinely-multi-selected semantics as
// NcnpSurveyGeography's governorate/center breakdown.
export interface NcnpNeedsGeography {
  byRegion: NcnpNamedBreakdown[];
  byGovernorate: NcnpNamedBreakdown[];
  byCenter: NcnpNamedBreakdown[];
}

export interface NcnpSubDomainBreakdown {
  domainName: string;
  subDomainName: string;
  needCount: number;
}

export interface NcnpOrgSummaryRow {
  organizationId: string;
  organizationName: string;
  studyCount: number;
  surveyCount: number;
  responseCount: number;
  isActive: boolean;
}

export interface NcnpOrgSummary {
  // Three independently-ranked top-5 lists rather than one combined table
  // sorted by a single metric (was responseCount) with the other columns
  // just along for the ride — a real "Organization Summary" that only
  // reflects one dimension reads as misleading (a very active-by-survey org
  // with few responses would never appear at all).
  byStudies: NcnpOrgSummaryRow[];
  bySurveys: NcnpOrgSummaryRow[];
  byResponses: NcnpOrgSummaryRow[];
  totalOrganizations: number;
}

export interface NcnpTopOrgByStudyCount {
  organizationId: string;
  organizationName: string;
  studyCount: number;
}

export interface NcnpStudyOverview {
  topOrgsByStudyCount: NcnpTopOrgByStudyCount[];
  totalOrganizations: number;
  studiesCreatedTrend: NcnpMonthlyPoint[];
}

export interface NcnpSurveyGeography {
  byRegion: NcnpNamedBreakdown[];
  byGovernorate: NcnpNamedBreakdown[];
  byCenter: NcnpNamedBreakdown[];
}

export interface NcnpRegionSummaryRow {
  regionId: string;
  regionName: string;
  surveyCount: number;
  responseCount: number;
  avgResponsesPerSurvey: number;
}

// A single Need, ranked by its own survey's village-priority assessment
// (VillagePriorityAssessment — see NcnpReportService.buildPriorityNeeds for
// exactly how "critical" is derived from real, existing data). `primaryGap`
// is a derived label (the lowest-performing domain component for this
// need's assessment), not a stored "gap type" field — there is no need-level
// gap-type column in the schema today; this is the closest real signal
// available without one.
export interface NcnpPriorityNeedRow {
  needId: string;
  needTitle: string;
  domain: string | null;
  subDomain: string | null;
  organizationName: string;
  priorityScore: number;
  priorityStatus: string;
  primaryGap: string | null;
  evidenceCount: number;
  source: string;
  // Unified Need Record Schema fields — all derived/joined from existing
  // data, no new columns (see docs/ncnp-unified-need-record-schema-analysis.md):
  // - equityFlag: derived from this assessment's own domain components
  //   (a critical domain that triggered an override) — a per-assessment
  //   classification, not a stored fact.
  // - indicatorId: the Question Bank's own `indicator` field, joined via
  //   this Need's Survey's questions — "the first indicator found," since a
  //   survey can touch several and there is no single indicator_id anywhere
  //   in the schema.
  // - unitGeoRegion: this Need's org's single Region (Organisation.regionId)
  //   — the one genuinely single-valued geography level; governorate/
  //   center/village stay real multi-select relations elsewhere in this
  //   report rather than being collapsed here.
  // - sourceRef: Need.referenceId — the submitter's own external tracking
  //   id, already on Need today under a different name.
  equityFlag: boolean;
  indicatorId: string | null;
  unitGeoRegion: string | null;
  sourceRef: string | null;
}

export interface NcnpCriticalNeedsOverview {
  // Capped at exactly 3 — the client's "Executive Summary: top three
  // critical needs" ask.
  topCriticalNeeds: NcnpPriorityNeedRow[];
  // A fuller ranked list for the "Priority Needs" section (score, evidence,
  // gap type, source per need) — capped wider than the executive summary's 3.
  priorityNeeds: NcnpPriorityNeedRow[];
  // How many of the platform's Needs have at least one village-priority
  // assessment behind them (i.e. actually rankable) — disclosed so the
  // report never implies full coverage when most Needs have never been
  // scored yet.
  totalRankableNeeds: number;
  totalNeeds: number;
}

// Always present, even when every count is zero — never omitted just
// because nothing has happened yet (e.g. no quality assessments run).
export interface NcnpDataQualityNotes {
  totalResponses: number;
  assessedResponses: number;
  lowConfidenceCount: number;
  duplicateFlaggedCount: number;
  totalNeeds: number;
  needsWithEvidence: number;
  needsWithoutEvidence: number;
  needsUnclassified: number;
}

// One (region, domain) cell — how many Needs in that region fall under that
// domain. Sparse (zero-count combinations omitted) and capped to the
// strongest intersections, not the full region x domain cross product.
export interface NcnpDomainRegionIntersection {
  regionName: string;
  domainName: string;
  needCount: number;
}

export interface NcnpReport {
  generatedAt: string;
  summary: NcnpReportSummary;
  orgHealth: NcnpOrgHealth;
  orgSummary: NcnpOrgSummary;
  needDomains: NcnpDomainBreakdown[];
  needSubDomains: NcnpSubDomainBreakdown[];
  needsGeography: NcnpNeedsGeography;
  studyStatus: NcnpStudyStatus;
  publicLinkStatus: NcnpPublicLinkStatus;
  studyOverview: NcnpStudyOverview;
  geography: NcnpGeographyOverview;
  surveyAnalytics: NcnpSurveyAnalytics;
  surveyGeography: NcnpSurveyGeography;
  regionSummary: NcnpRegionSummaryRow[];
  responseAnalytics: NcnpResponseAnalytics;
  priorityOverview: NcnpPriorityOverview;
  criticalNeeds: NcnpCriticalNeedsOverview;
  dataQualityNotes: NcnpDataQualityNotes;
  domainRegionIntersections: NcnpDomainRegionIntersection[];
}
