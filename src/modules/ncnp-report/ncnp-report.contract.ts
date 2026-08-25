import { registerSchema, T } from '../../contract/typebox';

// This module's controller (ncnp-report.controller.ts) has no request-body
// routes — GET / and GET /export take only query params, no @Body(). Only
// the response schema (GAP-08 Phase 0, batch 4) is registered here.
//
// Shape sourced from the frontend's NcnpReport and its full nested type tree
// (Project-RIO-Frontend/src/services/ncnp-report/ncnp-report.types.ts, which
// itself documents that it "mirrors the backend's NcnpReport shape exactly").
// Verified field-for-field against the backend's own ncnp-report.types.ts —
// identical shapes on both sides, no discrepancies found. Built bottom-up
// (leaf types first) to mirror the frontend file's own declaration order.

const NcnpPeriodStat = T.Object({
  current: T.Number(),
  previous: T.Number(),
  // null when previous is 0 — an undefined percentage, not a fabricated one.
  changePct: T.Union([T.Number(), T.Null()]),
});

const NcnpReportSummaryView = T.Object({
  totals: T.Object({
    organizations: T.Number(),
    studies: T.Number(),
    surveys: T.Number(),
    responses: T.Number(),
    needs: T.Number(),
  }),
  newThisPeriod: T.Object({
    periodDays: T.Number(),
    organizations: NcnpPeriodStat,
    studies: NcnpPeriodStat,
    surveys: NcnpPeriodStat,
    responses: NcnpPeriodStat,
  }),
});

const NcnpOrgNeedingAttention = T.Object({
  organizationId: T.String(),
  organizationName: T.String(),
  lastActivity: T.Union([T.String(), T.Null()]),
});

const NcnpOrgHealthView = T.Object({
  active: T.Number(),
  inactive: T.Number(),
  dormant: T.Number(),
  dormantDays: T.Number(),
  needsAttention: T.Array(NcnpOrgNeedingAttention),
});

const NcnpDomainBreakdown = T.Object({
  domainCode: T.String(),
  domainName: T.String(),
  needCount: T.Number(),
});

const NcnpStudyStatusView = T.Object({
  active: T.Number(),
  archived: T.Number(),
});

const NcnpSurveyStatusView = T.Object({
  draft: T.Number(),
  submitted: T.Number(),
  published: T.Number(),
  rejected: T.Number(),
});

const NcnpPublicLinkStatusView = T.Object({
  open: T.Number(),
  closed: T.Number(),
});

const NcnpRegionBreakdown = T.Object({
  regionId: T.String(),
  regionName: T.String(),
  count: T.Number(),
});

const NcnpRegionSurveyStatus = T.Object({
  regionId: T.String(),
  regionName: T.String(),
  count: T.Number(),
  status: NcnpSurveyStatusView,
});

const NcnpMonthlyPoint = T.Object({
  month: T.String(),
  count: T.Number(),
});

const NcnpGenderBreakdown = T.Object({
  gender: T.String(),
  count: T.Number(),
});

const NcnpAgeBracketBreakdown = T.Object({
  ageBracket: T.String(),
  count: T.Number(),
});

const NcnpOrgResponseStat = T.Object({
  organizationId: T.String(),
  organizationName: T.String(),
  value: T.Number(),
});

const NcnpResponseAnalyticsView = T.Object({
  monthlyTrend: T.Array(NcnpMonthlyPoint),
  responsesByRegion: T.Array(NcnpRegionBreakdown),
  genderDistribution: T.Array(NcnpGenderBreakdown),
  ageBracketDistribution: T.Array(NcnpAgeBracketBreakdown),
  hasResponsesWithoutAgeBracket: T.Boolean(),
  topOrgsByTotalResponses: T.Array(NcnpOrgResponseStat),
  topOrgsByAvgResponsesPerSurvey: T.Array(NcnpOrgResponseStat),
});

const NcnpRejectionReasonBreakdown = T.Object({
  reasonCode: T.String(),
  count: T.Number(),
});

const NcnpSurveyAnalyticsView = T.Object({
  statusPlatformWide: NcnpSurveyStatusView,
  statusByRegion: T.Array(NcnpRegionSurveyStatus),
  avgResponsesPerPublishedSurvey: T.Number(),
  rejectionReasonBreakdown: T.Array(NcnpRejectionReasonBreakdown),
});

const NcnpPriorityLevelBreakdown = T.Object({
  status: T.String(),
  count: T.Number(),
});

const NcnpDomainComparison = T.Object({
  domainKey: T.String(),
  domainName: T.String(),
  avgPerformanceScore: T.Number(),
  isCriticalDomain: T.Boolean(),
  assessmentCount: T.Number(),
});

const NcnpVillageScorecard = T.Object({
  studyId: T.String(),
  surveyId: T.String(),
  villageId: T.String(),
  priorityScore: T.Number(),
  priorityStatus: T.String(),
});

const NcnpPriorityOverviewView = T.Object({
  byStatus: T.Array(NcnpPriorityLevelBreakdown),
  domainComparison: T.Array(NcnpDomainComparison),
  topPriorityVillages: T.Array(NcnpVillageScorecard),
});

const NcnpNamedBreakdown = T.Object({
  id: T.String(),
  name: T.String(),
  count: T.Number(),
});

const NcnpGeographyOverviewView = T.Object({
  organizationsByRegion: T.Array(NcnpNamedBreakdown),
  organizationsByGovernorate: T.Array(NcnpNamedBreakdown),
  organizationsByCenter: T.Array(NcnpNamedBreakdown),
  studiesByRegion: T.Array(NcnpNamedBreakdown),
});

const NcnpNeedsGeographyView = T.Object({
  byRegion: T.Array(NcnpNamedBreakdown),
  byGovernorate: T.Array(NcnpNamedBreakdown),
  byCenter: T.Array(NcnpNamedBreakdown),
});

const NcnpSubDomainBreakdown = T.Object({
  domainName: T.String(),
  subDomainName: T.String(),
  needCount: T.Number(),
});

const NcnpOrgSummaryRow = T.Object({
  organizationId: T.String(),
  organizationName: T.String(),
  studyCount: T.Number(),
  surveyCount: T.Number(),
  responseCount: T.Number(),
  isActive: T.Boolean(),
});

const NcnpOrgSummaryView = T.Object({
  byStudies: T.Array(NcnpOrgSummaryRow),
  bySurveys: T.Array(NcnpOrgSummaryRow),
  byResponses: T.Array(NcnpOrgSummaryRow),
  totalOrganizations: T.Number(),
});

const NcnpTopOrgByStudyCount = T.Object({
  organizationId: T.String(),
  organizationName: T.String(),
  studyCount: T.Number(),
});

const NcnpStudyOverviewView = T.Object({
  topOrgsByStudyCount: T.Array(NcnpTopOrgByStudyCount),
  totalOrganizations: T.Number(),
  studiesCreatedTrend: T.Array(NcnpMonthlyPoint),
});

const NcnpSurveyGeographyView = T.Object({
  byRegion: T.Array(NcnpNamedBreakdown),
  byGovernorate: T.Array(NcnpNamedBreakdown),
  byCenter: T.Array(NcnpNamedBreakdown),
});

const NcnpRegionSummaryRow = T.Object({
  regionId: T.String(),
  regionName: T.String(),
  surveyCount: T.Number(),
  responseCount: T.Number(),
  avgResponsesPerSurvey: T.Number(),
});

const NcnpPriorityNeedRow = T.Object({
  needId: T.String(),
  needTitle: T.String(),
  domain: T.Union([T.String(), T.Null()]),
  subDomain: T.Union([T.String(), T.Null()]),
  organizationName: T.String(),
  priorityScore: T.Number(),
  priorityStatus: T.String(),
  primaryGap: T.Union([T.String(), T.Null()]),
  evidenceCount: T.Number(),
  source: T.String(),
  equityFlag: T.Boolean(),
  indicatorId: T.Union([T.String(), T.Null()]),
  unitGeoRegion: T.Union([T.String(), T.Null()]),
  sourceRef: T.Union([T.String(), T.Null()]),
});

const NcnpCriticalNeedsOverviewView = T.Object({
  topCriticalNeeds: T.Array(NcnpPriorityNeedRow),
  priorityNeeds: T.Array(NcnpPriorityNeedRow),
  totalRankableNeeds: T.Number(),
  totalNeeds: T.Number(),
});

const NcnpDataQualityNotesView = T.Object({
  totalResponses: T.Number(),
  assessedResponses: T.Number(),
  lowConfidenceCount: T.Number(),
  duplicateFlaggedCount: T.Number(),
  totalNeeds: T.Number(),
  needsWithEvidence: T.Number(),
  needsWithoutEvidence: T.Number(),
  needsUnclassified: T.Number(),
});

const NcnpDomainRegionIntersection = T.Object({
  regionName: T.String(),
  domainName: T.String(),
  needCount: T.Number(),
});

export const NcnpReportView = registerSchema(
  'NcnpReportView',
  T.Object({
    generatedAt: T.String(),
    summary: NcnpReportSummaryView,
    orgHealth: NcnpOrgHealthView,
    orgSummary: NcnpOrgSummaryView,
    needDomains: T.Array(NcnpDomainBreakdown),
    needSubDomains: T.Array(NcnpSubDomainBreakdown),
    needsGeography: NcnpNeedsGeographyView,
    studyStatus: NcnpStudyStatusView,
    publicLinkStatus: NcnpPublicLinkStatusView,
    studyOverview: NcnpStudyOverviewView,
    geography: NcnpGeographyOverviewView,
    surveyAnalytics: NcnpSurveyAnalyticsView,
    surveyGeography: NcnpSurveyGeographyView,
    regionSummary: T.Array(NcnpRegionSummaryRow),
    responseAnalytics: NcnpResponseAnalyticsView,
    priorityOverview: NcnpPriorityOverviewView,
    criticalNeeds: NcnpCriticalNeedsOverviewView,
    dataQualityNotes: NcnpDataQualityNotesView,
    domainRegionIntersections: T.Array(NcnpDomainRegionIntersection),
  }),
);
