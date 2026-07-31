import { SINGLE_CYCLE_TREND_NOTE } from "../../report-content.types";
import type {
  CollectiveDashboardData,
  CollectiveReportContent,
  CombinedReportContent,
  CoverageBlock,
  ExecutiveReportContent,
  IndividualSurveyReportContent,
  RegionReportContent,
  SectorReportContent,
  SharingStatusContent,
  SurveyIdentity,
  VillageReportContent,
} from "../../report-content.types";
import {
  ReportDataProvider,
  type ScopedReportQuery,
  type SurveyReportQuery,
  type VillageReportQuery,
} from "../report-data.provider";
import { buildComparisonBand, buildResponseFunnel } from "../survey-report-derivations";

// TEST-ONLY report content, shaped like RPT-2026-001. This is a test double,
// NOT a provider the app can use: it is deliberately not @Injectable and lives
// outside the production provider path, so Nest cannot resolve it and no
// user-facing report can ever be served from these values. Production data
// comes from ReportSummaryDataProvider only.
//
// Exists so the generator and export specs have stable, fully-populated content
// to assert against without standing up Prisma, Gemini and the priority engine.
export class StubReportDataProvider extends ReportDataProvider {
  async getVillageReport(query: VillageReportQuery): Promise<VillageReportContent> {
    // Mirrors RPT-2026-001 supplied by the team's AI summary.
    const villageName = query.villageId?.trim() || "Sample Village";
    return {
      header: {
        studyName: query.studyTitle ?? "Village Community Needs Assessment",
        entityName: null,
        methodologyVersion: "v1.0",
        reportGeneratedAt: "2026-07-22T10:30:00Z",
      },
      village: {
        id: villageName,
        name: villageName,
        assessmentCycle: query.assessmentCycle ?? 1,
        assessmentPeriod: query.assessmentPeriod ?? "01 July 2026 - 15 July 2026",
      },
      responseQuality: {
        submittedResponses: 42,
        validResponses: 38,
        overallConfidence: "STANDARD",
        confidencePct: 90,
        dontKnowRate: 12.4,
      },
      severity: {
        overallVillageNeedsIndex: 63.8,
        label: "Medium",
        domains: [
          { name: "Health", domainCode: "HEALTH", severityScore: 72, performanceScore: 28, weight: 0.3, weightedContribution: 8.4, confidence: "STANDARD", confidencePct: 92, kpiCount: 6, trendNote: SINGLE_CYCLE_TREND_NOTE, isCriticalDomain: true },
          { name: "Education", domainCode: "EDUCATION", severityScore: 48, performanceScore: 52, weight: 0.25, weightedContribution: 13, confidence: "STANDARD", confidencePct: 88, kpiCount: 5, trendNote: SINGLE_CYCLE_TREND_NOTE, isCriticalDomain: false },
          { name: "Infrastructure", domainCode: "INFRASTRUCTURE", severityScore: 63, performanceScore: 37, weight: 0.2, weightedContribution: 7.4, confidence: "STANDARD", confidencePct: 90, kpiCount: 4, trendNote: SINGLE_CYCLE_TREND_NOTE, isCriticalDomain: false },
          { name: "Livelihood", domainCode: "LIVELIHOOD", severityScore: 55, performanceScore: 45, weight: 0.15, weightedContribution: 6.75, confidence: "STANDARD", confidencePct: 85, kpiCount: 4, trendNote: SINGLE_CYCLE_TREND_NOTE, isCriticalDomain: false },
          { name: "Water & Sanitation", domainCode: "WATER_SANITATION", severityScore: 81, performanceScore: 19, weight: 0.1, weightedContribution: 1.9, confidence: "LOW", confidencePct: 62, kpiCount: 5, trendNote: SINGLE_CYCLE_TREND_NOTE, validResponseCount: 8, dontKnowRate: 25, isCriticalDomain: true },
        ],
      },
      priority: {
        villagePriorityScore: 37.45,
        priorityStatus: "HIGH",
        overrideApplied: true,
        overrideReason:
          "Critical Domain Override: Water & Sanitation performance score is 19, below the threshold of 30.",
      },
      topKpis: [
        { rank: 1, kpi: "Daily Clean Water Access", domain: "Water & Sanitation", severityScore: 88, confidence: "LOW", validResponseCount: 8 },
        { rank: 2, kpi: "Availability of Essential Medicines", domain: "Health", severityScore: 78, confidence: "STANDARD", validResponseCount: 35 },
        { rank: 3, kpi: "Distance to Primary Health Facility", domain: "Health", severityScore: 72, confidence: "STANDARD", validResponseCount: 36 },
      ],
      qualitativeEvidence: [
        { theme: "Water shortage", summary: "Respondents reported irregular water supply and long travel distance to collect water." },
        { theme: "Healthcare access", summary: "Community members highlighted medicine shortages and distance to nearby health facilities." },
      ],
      aiSummary: {
        executiveSummary: `${villageName} has a High Priority status. The weighted Village Priority Score is 37.45. Water & Sanitation and Health are the most significant areas of unmet need.`,
        keyFindings:
          "Water & Sanitation has the highest severity score of 81. Daily Clean Water Access is the highest-severity KPI at 88. Health also requires attention, particularly medicine availability and distance to health facilities.",
        // Promoted to top-level fields below — blanked here to avoid duplication.
        dataQualityNote: "",
        trendNote: "",
        recommendations: [
          "Validate water-access findings through additional household responses and local service records.",
          "Assess options to improve safe-water availability and reliability.",
          "Review medicine availability and health-facility access barriers with relevant service providers.",
        ],
      },
      dataQualityNote:
        "Water & Sanitation findings have Low Confidence because only 8 valid responses were available and the Don't Know rate was 25%. These findings should be validated through additional field data collection.",
      trendNote: "Cycle 1 assessment: Trend Pending.",
      approval: {
        officerConfirmedBy: "Research Officer - Demo User",
        officerConfirmedAt: "2026-07-22T09:30:00Z",
        reviewerApprovedBy: "Reviewer - Demo User",
        reviewerApprovedAt: "2026-07-22T10:20:00Z",
      },
      // Sample gender/rural distribution so the demographic charts render. When
      // real demographic capture ships, this comes from getDemographics instead
      // (null → "Not available"), with no shape change.
      demographics: {
        gender: [
          { label: "Female", count: 21 },
          { label: "Male", count: 17 },
        ],
        rural: [
          { label: "Rural", count: 26 },
          { label: "Urban", count: 12 },
        ],
      },
      filters: query.filters,
    };
  }

  // Coverage counts for the survey-scoped fixtures. Internally consistent with
  // the village fixture's response quality (42 submitted / 38 valid) so a spec
  // asserting "the funnel agrees with the response-quality tile" is meaningful.
  private stubCoverage(): CoverageBlock {
    return {
      studyTitle: "Village Community Needs Assessment",
      studyCycleNumber: 1,
      needsInStudy: 3,
      needsCoveredByThisSurvey: 1,
      surveysInStudy: 2,
      villagesCovered: 2,
      villageNames: ["Sample Village", "Riverside Village"],
      governoratesCovered: 1,
      centersCovered: 2,
      surveyQuestionsTotal: 28,
      surveyQuestionsFromBank: 25,
      surveyQuestionsCustom: 3,
      publicSurveyLinks: 2,
      activeSurveyLinks: 1,
      responsesSubmitted: 42,
      responsesValid: 38,
      responsesExcluded: 4,
      dontKnowRatePct: 12,
      duplicateResponses: 1,
      lowConfidenceResponses: 5,
      evidenceFilesTotal: 6,
      evidenceIncludedInReport: 4,
      domainsScored: 5,
      kpisScored: 24,
      assessmentPeriod: "01 July 2026 - 15 July 2026",
    };
  }

  private stubSurveyIdentity(query: SurveyReportQuery): SurveyIdentity {
    return {
      surveyId: query.surveyId,
      surveyTitle: "Baseline Household Survey",
      surveyStatus: "PUBLISHED",
      needStatement: "Households report irregular access to safe drinking water.",
      needStatus: "survey_published",
      villageName: "Sample Village",
      assessmentCycle: 1,
      assessmentPeriod: query.assessmentPeriod ?? "01 July 2026 - 15 July 2026",
      methodologyVersion: "v1.0",
      publishedAt: "2026-07-01T08:00:00Z",
    };
  }

  async getIndividualSurveyReport(query: SurveyReportQuery): Promise<IndividualSurveyReportContent> {
    // Built from the village fixture so the two share identical severity /
    // priority / topKpis blocks — the same relationship the real provider
    // guarantees through a single shared snapshot.
    const village = await this.getVillageReport({
      studyId: query.studyId,
      villageId: "Sample Village",
      orgId: query.orgId,
      studyTitle: query.studyTitle,
      filters: query.filters,
    });
    const coverage = this.stubCoverage();
    return {
      header: village.header,
      survey: this.stubSurveyIdentity(query),
      coverage,
      responseQuality: village.responseQuality,
      severity: village.severity,
      priority: village.priority,
      topKpis: village.topKpis,
      responseFunnel: buildResponseFunnel(coverage),
      questionCoverage: village.severity.domains.map((d) => ({ domain: d.name, count: d.kpiCount })),
      qualitativeEvidence: village.qualitativeEvidence,
      aiSummary: village.aiSummary,
      dataQualityNote: village.dataQualityNote,
      trendNote: village.trendNote,
      approval: village.approval,
      demographics: village.demographics,
      filters: query.filters,
    };
  }

  async getCombinedReport(query: SurveyReportQuery): Promise<CombinedReportContent> {
    const individual = await this.getIndividualSurveyReport(query);
    const dashboard = await this.getCollectiveDashboard({ orgId: query.orgId, filters: query.filters });
    return {
      header: individual.header,
      survey: individual.survey,
      coverage: individual.coverage,
      portfolio: {
        studiesTotal: 4,
        needsTotal: 24,
        needsByStatus: [
          { label: "survey_published", count: 14 },
          { label: "reviewer_approved", count: 7 },
          { label: "draft", count: 3 },
        ],
        surveysTotal: 9,
        surveysByStatus: [
          { label: "PUBLISHED", count: 6 },
          { label: "DRAFT", count: 2 },
          { label: "SUBMITTED", count: 1 },
        ],
        publicLinksTotal: 11,
        responsesTotal: 210,
        evidenceFilesTotal: 31,
        reportsTotal: 12,
        reportsByStatus: [
          { label: "released", count: 7 },
          { label: "draft", count: 4 },
          { label: "archived", count: 1 },
        ],
        sharingRequestsTotal: 10,
        sharingRequestsByStatus: [
          { label: "approved", count: 8 },
          { label: "pending", count: 2 },
        ],
        villagesCovered: 9,
        governoratesCovered: 3,
        thisSurveyShareOfResponsesPct: 20,
      },
      responseQuality: individual.responseQuality,
      severity: individual.severity,
      priority: individual.priority,
      topKpis: individual.topKpis,
      responseFunnel: individual.responseFunnel,
      questionCoverage: individual.questionCoverage,
      demographics: individual.demographics,
      dashboard: {
        capturedAt: "2026-07-22T10:30:00Z",
        kpis: { needCount: dashboard.needCount, slaCompliancePct: 92, slaBreaches: 1, slaAtRisk: 2 },
        scoringDistribution: dashboard.scoringDistribution,
        topPriorities: dashboard.topPriorities,
        trends: dashboard.trends,
        anomalies: dashboard.anomalies.map((a) => `[${a.severity.toUpperCase()}] ${a.note}`),
        reviewerNotes: dashboard.reviewerNotes,
      },
      comparison: buildComparisonBand(
        // The real provider passes its snapshot; the fixture reconstructs the
        // two fields buildComparisonBand actually reads, so the band under test
        // is the real function, not a hand-written stand-in.
        {
          severity: { overallVillageNeedsIndex: individual.severity.overallVillageNeedsIndex },
          priority: { villagePriorityScore: individual.priority.villagePriorityScore },
        } as never,
        dashboard,
        individual.coverage,
      ),
      aiSummary: individual.aiSummary,
      dataQualityNote: individual.dataQualityNote,
      trendNote: individual.trendNote,
      approval: individual.approval,
      filters: query.filters,
    };
  }

  async getSectorReport(query: ScopedReportQuery): Promise<SectorReportContent> {
    return {
      header: {
        studyName: query.studyTitle ?? "Sector Needs Assessment",
        entityName: null,
        methodologyVersion: "v1.0",
        reportGeneratedAt: "2026-07-22T10:30:00Z",
      },
      domains: [
        { name: "Health", domainCode: "HEALTH", severityScore: 72, performanceScore: 28, weight: 0.3, weightedContribution: 8.4, confidence: "STANDARD", confidencePct: 92, kpiCount: 6, trendNote: SINGLE_CYCLE_TREND_NOTE, isCriticalDomain: true },
        { name: "Water & Sanitation", domainCode: "WATER_SANITATION", severityScore: 81, performanceScore: 19, weight: 0.1, weightedContribution: 1.9, confidence: "LOW", confidencePct: 62, kpiCount: 5, trendNote: SINGLE_CYCLE_TREND_NOTE, validResponseCount: 8, dontKnowRate: 25, isCriticalDomain: true },
      ],
      overall: {
        overallVillageNeedsIndex: 63.8,
        label: "Medium",
        domains: [],
      },
      aiSummary: {
        executiveSummary: "Health and Water & Sanitation are the highest-severity sectors across the study.",
        keyFindings: "Water & Sanitation shows the highest severity (81) but low confidence.",
        // Promoted to top-level fields below — blanked here to avoid duplication.
        dataQualityNote: "",
        trendNote: "",
        recommendations: ["Prioritise Water & Sanitation interventions.", "Validate low-confidence sector findings."],
      },
      dataQualityNote: "Water & Sanitation confidence is Low pending additional field data.",
      trendNote: "Cycle 1 assessment: Trend Pending.",
      demographics: null,
      filters: query.filters,
    };
  }

  async getRegionReport(query: ScopedReportQuery): Promise<RegionReportContent> {
    return {
      header: {
        studyName: query.studyTitle ?? "Regional Needs Assessment",
        entityName: null,
        methodologyVersion: "v1.0",
        reportGeneratedAt: "2026-07-22T10:30:00Z",
      },
      regions: [
        { needCount: 12, regionName: "Sample Region", governorate: "Sample Governorate", responseCount: 38, severityScore: 63, priorityScore: 37.45, priorityStatus: "HIGH" },
      ],
      aiSummary: {
        executiveSummary: "Sample Region shows High priority driven by water and health needs.",
        keyFindings: "One governorate reports 12 needs with High priority status.",
        // Promoted to top-level fields below — blanked here to avoid duplication.
        dataQualityNote: "",
        trendNote: "",
        recommendations: ["Focus resources on the highest-priority governorate."],
      },
      dataQualityNote: "Regional aggregation is based on approved priority scores.",
      trendNote: "Cycle 1 assessment: Trend Pending.",
      demographics: null,
      filters: query.filters,
    };
  }

  async getExecutiveReport(query: ScopedReportQuery): Promise<ExecutiveReportContent> {
    return {
      header: {
        studyName: query.studyTitle ?? "Executive Summary",
        entityName: null,
        methodologyVersion: "v1.0",
        reportGeneratedAt: "2026-07-22T10:30:00Z",
      },
      scope: { villages: "Consolidated Governorates", governorate: "Sample Governorate" },
      topPriorities: [
        { rank: 1, kpi: "Daily Clean Water Access", domain: "Water & Sanitation", severityScore: 88, confidence: "LOW", validResponseCount: 8 },
        { rank: 2, kpi: "Availability of Essential Medicines", domain: "Health", severityScore: 78, confidence: "STANDARD", validResponseCount: 35 },
      ],
      responseQuality: {
        submittedResponses: 42,
        validResponses: 38,
        overallConfidence: "STANDARD",
        confidencePct: 90,
        dontKnowRate: 12.4,
      },
      aiSummary: {
        executiveSummary: "Water and health are the dominant strategic priorities across all entities.",
        keyFindings: "Daily Clean Water Access is the highest-severity KPI at 88.",
        // Promoted to top-level fields below — blanked here to avoid duplication.
        dataQualityNote: "",
        trendNote: "",
        recommendations: ["Prioritise water access.", "Validate low-confidence findings."],
      },
      dataQualityNote: "Water findings carry Low Confidence and should be field-validated.",
      trendNote: "Cycle 1 assessment: Trend Pending.",
      anomalies: ["Water & Sanitation flagged: Low Confidence with a critical-domain override."],
      reviewerNotes: null,
      demographics: null,
      filters: query.filters,
    };
  }

  async getCollectiveReport(query: ScopedReportQuery): Promise<CollectiveReportContent> {
    const kpis = {
      needCount: 24,
      scoringDistribution: [
        { band: "High", count: 8 },
        { band: "Medium", count: 10 },
        { band: "Low", count: 6 },
      ],
      slaCompliancePct: null,
    };
    return {
      header: {
        studyName: "Collective Community Needs Report",
        entityName: null,
        methodologyVersion: "v1.0",
        reportGeneratedAt: "2026-07-22T10:30:00Z",
      },
      kpis: { needCount: kpis.needCount, slaCompliancePct: kpis.slaCompliancePct },
      scoringDistribution: kpis.scoringDistribution,
      aiSummary: {
        executiveSummary:
          "Across all completed studies, Water & Sanitation and Health are the dominant unmet needs. 8 of 24 needs are High priority.",
        keyFindings:
          "Water accessibility is the most frequently reported need; three governorates report recurring infrastructure concerns.",
        dataQualityNote:
          "SLA compliance is not yet available — the reviewer-SLA source is pending integration.",
        trendNote: "First collective cycle: trend baseline established.",
        recommendations: [
          "Prioritise water-accessibility interventions across the highest-severity governorates.",
          "Coordinate with local authorities on recurring infrastructure concerns.",
        ],
      },
      filters: query.filters,
    };
  }

  async getSharingStatus(query: ScopedReportQuery): Promise<SharingStatusContent> {
    return {
      header: {
        studyName: "Report Sharing Status",
        entityName: null,
        methodologyVersion: "v1.0",
        reportGeneratedAt: "2026-07-22T10:30:00Z",
      },
      summary: { approved: 8, pending: 2, rejected: 0 },
      requests: [
        { reportTitle: "Village Report — Sample Village", requestingOrg: "Riverside Community Trust", ownerOrg: "Demo NGO", status: "approved", requestedAt: "2026-07-20T09:00:00Z", decidedAt: "2026-07-21T10:00:00Z" },
        { reportTitle: "Executive Summary", requestingOrg: "Riverside Community Trust", ownerOrg: "Demo NGO", status: "pending", requestedAt: "2026-07-22T08:30:00Z", decidedAt: null },
      ],
      filters: query.filters,
    };
  }

  async getCollectiveDashboard(_query: ScopedReportQuery): Promise<CollectiveDashboardData> {
    return {
      needCount: 24,
      scoringDistribution: [
        { band: "High", count: 8 },
        { band: "Medium", count: 10 },
        { band: "Low", count: 6 },
      ],
      topPriorities: [
        { rank: 1, label: "Daily Clean Water Access", domain: "Water & Sanitation", severityScore: 88, entity: "Sample Village" },
        { rank: 2, label: "Availability of Essential Medicines", domain: "Health", severityScore: 78, entity: "Sample Village" },
        { rank: 3, label: "Distance to Primary Health Facility", domain: "Health", severityScore: 72, entity: "Riverside Village" },
      ],
      trends: [
        { label: "Water & Sanitation severity", direction: "up", note: "Rising vs. previous cycle in two villages." },
        { label: "Overall data confidence", direction: "flat", note: "Stable at Standard confidence." },
      ],
      anomalies: [
        { severity: "warning", note: "Water & Sanitation flagged: Low Confidence with a critical-domain override." },
        { severity: "info", note: "Don't-Know rate above 20% in one village's water indicators." },
      ],
      reviewerNotes: [
        { author: "Reviewer - Demo User", note: "Validate water-access findings before publication.", at: "2026-07-22T10:20:00Z" },
      ],
    };
  }
}
