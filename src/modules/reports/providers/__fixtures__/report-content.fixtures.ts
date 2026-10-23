import { SINGLE_CYCLE_TREND_NOTE } from "../../report-content.types";
import type {
  CollectiveDashboardData,
  CollectiveReportContent,
  CombinedReportContent,
  CoverageBlock,
  DataQualityReportContent,
  ExecutiveReportContent,
  IndividualSurveyReportContent,
  RegionReportContent,
  SectorReportContent,
  SharingStatusContent,
  SurveyIdentity,
  TopPriorityReportContent,
  VillageReportContent,
} from "../../report-content.types";
import {
  ReportDataProvider,
  type ScopedReportQuery,
  type SurveyReportQuery,
  type VillageReportQuery,
} from "../report-data.provider";
import { buildComparisonBand, buildResponseFunnel } from "../survey-report-derivations";
import { buildUnifiedRpt01, type UnifiedRpt01Input } from "../build-unified-rpt01";
import { buildDataQualityContent, buildTopPriorityContent } from "../build-focused-reports";
import type { DataCollectionCompletenessBlock } from "../load-data-collection-completeness";
import { summariseAbandonment } from "../../../survey-sessions/abandonment";
import { REGION_AGGREGATION_BASIS } from "../snapshot-to-content";
import type { ClassificationRow, KpiRollupRow } from "../build-need-records";
import type { DomainMeta, RollupLevelValue } from "../build-need-hierarchy";
import { DEFAULT_THRESHOLDS } from "../../need-record.types";

// TEST-ONLY report content, shaped like RPT-2026-001. This is a test double,
// NOT a provider the app can use: it is deliberately not @Injectable and lives
// outside the production provider path, so Nest cannot resolve it and no
// user-facing report can ever be served from these values. Production data
// comes from ReportSummaryDataProvider only.
//
// Exists so the generator and export specs have stable, fully-populated content
// to assert against without standing up Prisma, Gemini and the priority engine.
export class StubReportDataProvider extends ReportDataProvider {
  /**
   * The source Need's affected-population estimate, as the real provider would
   * have read it from `Survey.needId → Need.affectedPopulation`.
   *
   * Null by default: a Need recorded before the need-entry question existed,
   * which is the state most of these specs assert against (dashed column, note
   * saying why). Construct with a number to exercise the populated column.
   */
  constructor(private readonly sourceNeedAffectedPopulation: number | null = null) {
    super();
  }

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
        population: 5000,
        requiredSampleSize: 94,
        minimumDetectableEffect: 14.4,
        confidenceReason: "High response completeness.",
        validResponseRatePct: 90,
        dontKnowRate: 12.4,
        dontKnowBand: "moderate",
      },
      severity: {
        overallVillageNeedsIndex: 63.8,
        label: "Medium",
        domains: [
          { name: "Health", domainCode: "HEALTH", severityScore: 72, performanceScore: 28, weight: 0.3, weightedContribution: 8.4, confidence: "STANDARD", confidenceReason: "High response completeness.", validResponseRatePct: 92, kpiCount: 6, trendNote: SINGLE_CYCLE_TREND_NOTE, isCriticalDomain: true, maxKpiSeverity: 86, maxKpiName: "Distance to nearest clinic", criticalKpiCount: 2, masksCriticalFinding: false },
          { name: "Education", domainCode: "EDUCATION", severityScore: 48, performanceScore: 52, weight: 0.25, weightedContribution: 13, confidence: "STANDARD", confidenceReason: "High response completeness.", validResponseRatePct: 88, kpiCount: 5, trendNote: SINGLE_CYCLE_TREND_NOTE, isCriticalDomain: false, maxKpiSeverity: 74, maxKpiName: "Pupil-teacher ratio", criticalKpiCount: 1, masksCriticalFinding: true },
          { name: "Infrastructure", domainCode: "INFRASTRUCTURE", severityScore: 63, performanceScore: 37, weight: 0.2, weightedContribution: 7.4, confidence: "STANDARD", confidenceReason: "High response completeness.", validResponseRatePct: 90, kpiCount: 4, trendNote: SINGLE_CYCLE_TREND_NOTE, isCriticalDomain: false, maxKpiSeverity: 68, maxKpiName: "Road access in wet season", criticalKpiCount: 0, masksCriticalFinding: false },
          { name: "Livelihood", domainCode: "LIVELIHOOD", severityScore: 55, performanceScore: 45, weight: 0.15, weightedContribution: 6.75, confidence: "STANDARD", confidenceReason: "High response completeness.", validResponseRatePct: 85, kpiCount: 4, trendNote: SINGLE_CYCLE_TREND_NOTE, isCriticalDomain: false, maxKpiSeverity: 61, maxKpiName: "Household income adequacy", criticalKpiCount: 0, masksCriticalFinding: false },
          { name: "Water & Sanitation", domainCode: "WATER_SANITATION", severityScore: 81, performanceScore: 19, weight: 0.1, weightedContribution: 1.9, confidence: "LOW", confidenceReason: "Small sample: 8 valid response(s), below the 10 required for STANDARD confidence.", validResponseRatePct: 62, kpiCount: 5, trendNote: SINGLE_CYCLE_TREND_NOTE, validResponseCount: 8, dontKnowRate: 25, isCriticalDomain: true, maxKpiSeverity: 88, maxKpiName: "Households with safe water access", criticalKpiCount: 3, masksCriticalFinding: false },
        ],
      },
      priority: {
        villagePriorityScore: 37.45,
        priorityStatus: "HIGH",
        notCalculableReason: null,
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
      kpisAttempted: 24,
      kpisScored: 24,
      kpisNotMeasurable: 0,
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
    // The six Unified Narrative sections are produced by the REAL pure builder,
    // not hand-written — a fixture that hand-rolls them would let the builder
    // regress while the export specs stayed green.
    const unified = buildUnifiedRpt01(stubUnifiedInput(village, coverage));
    return {
      ...unified,
      header: village.header,
      survey: this.stubSurveyIdentity(query),
      coverage,
      responseQuality: village.responseQuality,
      severity: village.severity,
      priority: village.priority,
      topKpis: village.topKpis,
      responseFunnel: buildResponseFunnel(coverage),
      questionCoverage: village.severity.domains.map((d) => ({ domain: d.name, count: d.kpiCount })),
      // RPT01 is SURVEY_ONLY — it must not borrow the village report's document
      // evidence, or the mock contradicts the Report Basis line the real
      // provider prints. The real path supplies no evidence for this scope
      // either (see report-summary.service.ts).
      qualitativeEvidence: [],
      aiSummary: village.aiSummary,
      dataQualityNote: village.dataQualityNote,
      trendNote: village.trendNote,
      approval: village.approval,
      demographics: village.demographics,
      filters: query.filters,
    };
  }

  // RPT03/RPT09 and RPT10. Both go through the REAL pure mappers over the same
  // unified sections the RPT01 fixture uses — so the specs assert the actual
  // projection logic, and the three reports reconcile in the fixture exactly as
  // they must in production.
  private async stubUnified(query: ScopedReportQuery): Promise<{
    village: VillageReportContent;
    unified: ReturnType<typeof buildUnifiedRpt01>;
  }> {
    const village = await this.getVillageReport({
      studyId: query.studyId ?? "study-1",
      villageId: "Sample Village",
      orgId: query.orgId,
      studyTitle: query.studyTitle,
      filters: query.filters,
    });
    return {
      village,
      unified: buildUnifiedRpt01(
        stubUnifiedInput(village, this.stubCoverage(), this.sourceNeedAffectedPopulation),
      ),
    };
  }

  async getTopPriorityReport(query: ScopedReportQuery): Promise<TopPriorityReportContent> {
    const { village, unified } = await this.stubUnified(query);
    return buildTopPriorityContent({
      header: village.header,
      unified,
      responseQuality: village.responseQuality,
      aiSummary: village.aiSummary,
      dataQualityNote: village.dataQualityNote,
      trendNote: village.trendNote,
      demographics: village.demographics,
      domains: village.severity.domains,
      scope: { villages: village.village.name, governorate: null },
      filters: query.filters,
    });
  }

  async getDataQualityReport(query: ScopedReportQuery): Promise<DataQualityReportContent> {
    const { village, unified } = await this.stubUnified(query);
    return buildDataQualityContent({
      header: village.header,
      unified,
      responseQuality: village.responseQuality,
      aiSummary: village.aiSummary,
      dataQualityNote: village.dataQualityNote,
      trendNote: village.trendNote,
      demographics: village.demographics,
      domains: village.severity.domains,
      // Built by the REAL summariser over stub session rows, so the fixture
      // cannot drift from the production abandonment arithmetic — same rule
      // as the unified builder above.
      dataCollection: stubDataCollection(),
      filters: query.filters,
    });
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
      scopeBasis: {
        surveyId: "survey-1",
        surveyTitle: "Village Needs Survey — Cycle 1",
        studySurveyCount: 1,
        resolution: "LATEST_PUBLISHED",
        partialScopeNote: null,
      },
      severity: {
        overallVillageNeedsIndex: 63.8,
        label: "Medium",
        // Nested here, not at the top level: `severity` is the key both
        // renderers read. See SectorReportContent.severity.
        domains: [
          // Averages MEDIUM (44) over a CRITICAL KPI (86) — the no-masking case
          // the methodology exists for, so the fixture exercises the alert
          // rather than only the happy path.
          { name: "Health", domainCode: "HEALTH", severityScore: 44, performanceScore: 56, weight: 0.3, weightedContribution: 13.2, confidence: "STANDARD", confidenceReason: "High response completeness.", validResponseRatePct: 92, kpiCount: 6, trendNote: SINGLE_CYCLE_TREND_NOTE, isCriticalDomain: true, maxKpiSeverity: 86, maxKpiName: "Distance to nearest clinic", criticalKpiCount: 1, masksCriticalFinding: true },
          { name: "Water & Sanitation", domainCode: "WATER_SANITATION", severityScore: 81, performanceScore: 19, weight: 0.1, weightedContribution: 1.9, confidence: "LOW", confidenceReason: "Small sample: 8 valid response(s), below the 10 required for STANDARD confidence.", validResponseRatePct: 62, kpiCount: 5, trendNote: SINGLE_CYCLE_TREND_NOTE, validResponseCount: 8, dontKnowRate: 25, isCriticalDomain: true, maxKpiSeverity: 88, maxKpiName: "Households with safe water access", criticalKpiCount: 3, masksCriticalFinding: false },
        ],
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
      // Two governorates with DIFFERENT figures — a fixture where both rows
      // matched would pass even if the report went back to printing one
      // study-wide number under every governorate's name.
      regionScope: {
        regionName: "Sample Region",
        governorateCount: 2,
        villageCount: 3,
        unmappedNeedCount: 1,
        unscoredVillages: ["Unscored Village"],
        aggregationBasis: REGION_AGGREGATION_BASIS,
      },
      regions: [
        { needCount: 12, regionName: "Sample Region", governorate: "North Governorate", responseCount: 38, severityScore: 63, maxVillageSeverity: 81, priorityScore: 37.45, priorityStatus: "HIGH" },
        { needCount: 5, regionName: "Sample Region", governorate: "South Governorate", responseCount: 14, severityScore: 41, maxVillageSeverity: 44, priorityScore: 62.1, priorityStatus: "MEDIUM" },
      ],
      villages: [
        { village: "Sample Village", governorate: "North Governorate", needCount: 8, responseCount: 26, severityScore: 81, priorityScore: 31.2, priorityStatus: "HIGH" },
        { village: "North Hamlet", governorate: "North Governorate", needCount: 4, responseCount: 12, severityScore: 45, priorityScore: 43.7, priorityStatus: "MEDIUM" },
        { village: "Unscored Village", governorate: "South Governorate", needCount: 5, responseCount: 14, severityScore: null, priorityScore: null, priorityStatus: null },
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
        population: 5000,
        requiredSampleSize: 94,
        minimumDetectableEffect: 14.4,
        confidenceReason: "High response completeness.",
        validResponseRatePct: 90,
        dontKnowRate: 12.4,
        dontKnowBand: "moderate",
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

// Fixture inputs for the real RPT01 section builder. Derived from the village
// fixture's own domains so the sections cannot disagree with the severity table
// they sit beside — which is exactly what the self-consistency invariants check.
function stubUnifiedInput(
  village: VillageReportContent,
  coverage: CoverageBlock,
  // The source Need's affected-population estimate. Defaults to null — the
  // shape of a Need recorded before the question was asked, which is what most
  // of these specs assert against. Pass a number to exercise the populated
  // column.
  sourceNeedAffectedPopulation: number | null = null,
): UnifiedRpt01Input {
  const kpiRollups: KpiRollupRow[] = [];
  const classificationByIndicator = new Map<string, ClassificationRow>();
  const domainMetaByKey = new Map<string, DomainMeta>();
  const subDomainByKey = new Map<string, RollupLevelValue>();
  const indicatorByKey = new Map<string, RollupLevelValue>();
  const domainWeightByKey = new Map<string, number | null>();

  for (const d of village.severity.domains) {
    const subDomain = `${d.name} Services`;
    subDomainByKey.set(subDomain, { severityScore: d.severityScore, confidence: d.confidence });
    domainWeightByKey.set(d.domainCode, d.weight);
    domainMetaByKey.set(d.domainCode, {
      domain: d.name,
      domainKey: d.domainCode,
      severityScore: d.severityScore,
      performanceScore: d.performanceScore,
      weight: d.weight,
      weightedContribution: d.weightedContribution,
      confidence: d.confidence,
      confidenceReason: d.confidenceReason,
      isCriticalDomain: d.isCriticalDomain,
      kpisDefined: d.kpiCount,
      questionsAsked: d.kpiCount,
      priorCycleSeverity: null,
    });

    for (let i = 1; i <= d.kpiCount; i += 1) {
      const kpi = `${d.domainCode}-K${i}`;
      const indicator = `${d.name} Indicator ${i}`;
      indicatorByKey.set(indicator, { severityScore: d.severityScore, confidence: d.confidence });
      classificationByIndicator.set(kpi, {
        domain: d.name,
        domainKey: d.domainCode,
        subDomain,
        subDomainKey: `${d.domainCode}_SERVICES`,
        indicatorId: indicator,
        indicatorName: indicator,
        gapTypeHint: null,
      });
      kpiRollups.push({
        entityId: kpi,
        entityNameSnapshot: `${d.name} KPI ${i}`,
        severityScore: d.severityScore,
        confidenceLevel: d.confidence,
        validResponseCount: 38,
        excludedResponseCount: 4,
        dontKnowCount: 2,
        notApplicableCount: 0,
        dontKnowRate: 0.124,
      });
    }
  }

  return {
    generatedAt: "2026-07-22T10:30:00Z",
    surveyId: "stub-survey",
    surveyTitle: "Baseline Household Survey",
    studyId: "stub-study",
    snapshotId: "snap-stub",
    methodologyVersionId: "stub-mv",
    methodologyVersionLabel: "v1.0",
    assessmentCycle: 1,
    calculatedAt: "2026-07-22T09:00:00Z",
    villageScope: "",
    unitGeo: {
      regionId: null,
      regionName: "Al-Qassim",
      governorateIds: [],
      governorateNames: ["Al-Badai"],
      centerIds: [],
      centerNames: [],
      villages: coverage.villageNames,
      scopeLabel: "Al-Badai, Al-Qassim — all 2 village(s) (consolidated)",
    },
    sourceNeedAffectedPopulation,
    kpiRollups,
    classificationByIndicator,
    segmentsByIndicator: new Map(),
    priorCycleByIndicator: new Map(),
    subDomainByKey,
    indicatorByKey,
    domainMetaByKey,
    allDomains: village.severity.domains.map((d) => ({
      domain: d.name,
      domainKey: d.domainCode,
      subDomainCount: 1,
    })),
    domainWeightByKey,
    overallNeedsIndex: village.severity.overallVillageNeedsIndex,
    overallConfidence: village.responseQuality.overallConfidence,
    overallConfidenceReason: village.responseQuality.confidenceReason,
    priorCycleOverallSeverity: null,
    responseQuality: {
      submitted: coverage.responsesSubmitted,
      valid: coverage.responsesValid,
      excluded: coverage.responsesExcluded,
      dontKnowRate: 0.124,
      duplicatesFlagged: coverage.duplicateResponses,
      lowConfidenceFlagged: coverage.lowConfidenceResponses,
    },
    dontKnowRateByDomain: village.severity.domains.map((d) => ({ domain: d.name, rate: 0.124 })),
    exclusionBreakdown: [
      { status: "SCORED", count: 38 },
      { status: "EXCLUDED", count: 4 },
    ],
    totalAnswers: 42,
    villagePriority: {
      priorityScore: village.priority.villagePriorityScore,
      overrideApplied: village.priority.overrideApplied,
      overrideReason: village.priority.overrideReason,
      assessedWeightSum: 1,
    },
    thresholds: DEFAULT_THRESHOLDS,
  };
}

// ── RPT10 data-collection completeness (client Q14 (a), settled 24 Aug) ──
//
// Two abandoned sittings, one still in flight, three submitted, and one
// required question with gaps — enough for every branch of the rendering
// (rate, stage breakdown, itemised rows, invalid-response arithmetic) to be
// asserted against real output rather than an empty block.
function stubDataCollection(): DataCollectionCompletenessBlock {
  const now = new Date("2026-08-24T12:00:00.000Z");
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
  const abandonment = summariseAbandonment(
    [
      // Submitted — the outcome the rate is measured against.
      { id: "aaaaaaaa-0000-0000-0000-000000000001", surveyId: "srv-1", furthestStep: "SUBMITTED", questionCount: 10, answeredCount: 10, startedAt: at(300), lastEventAt: at(295), submittedAt: at(295), remindersSent: 0 },
      { id: "aaaaaaaa-0000-0000-0000-000000000002", surveyId: "srv-1", furthestStep: "SUBMITTED", questionCount: 10, answeredCount: 10, startedAt: at(280), lastEventAt: at(276), submittedAt: at(276), remindersSent: 1 },
      { id: "aaaaaaaa-0000-0000-0000-000000000003", surveyId: "srv-1", furthestStep: "SUBMITTED", questionCount: 10, answeredCount: 10, startedAt: at(200), lastEventAt: at(196), submittedAt: at(196), remindersSent: 0 },
      // Abandoned — past the idle threshold, never submitted.
      { id: "bbbbbbbb-0000-0000-0000-000000000001", surveyId: "srv-1", furthestStep: "ANSWERING", questionCount: 10, answeredCount: 4, startedAt: at(400), lastEventAt: at(380), submittedAt: null, remindersSent: 2 },
      { id: "bbbbbbbb-0000-0000-0000-000000000002", surveyId: "srv-1", furthestStep: "DETAILS", questionCount: 10, answeredCount: 0, startedAt: at(500), lastEventAt: at(495), submittedAt: null, remindersSent: 0 },
      // In flight — inside the window, so on neither side of the rate.
      { id: "cccccccc-0000-0000-0000-000000000001", surveyId: "srv-1", furthestStep: "ANSWERING", questionCount: 10, answeredCount: 2, startedAt: at(10), lastEventAt: at(3), submittedAt: null, remindersSent: 0 },
    ],
    now,
    120,
  );

  return {
    scope: {
      level: "STUDY",
      surveyId: null,
      surveysInStudy: 1,
      coveredSurveys: [{ surveyId: "srv-1", title: "Baseline Survey", version: 1, status: "PUBLISHED", responses: 3 }],
      excludedSurveys: [],
      note: "Study-level report. These completeness figures aggregate all 1 survey(s) in this study.",
    },
    abandonment: {
      ...abandonment,
      submittedResponsesInScope: 3,
      trackedResponses: abandonment.submitted,
      responsesWithoutSession: 0,
      note: "Stub scope: every submitted response has a session record behind it.",
    },
    unansweredRequired: {
      requiredQuestionCount: 8,
      submittedResponses: 3,
      requiredAnswerSlots: 24,
      unansweredCount: 2,
      unansweredRatePct: 8.3,
      byQuestion: [
        {
          questionRef: "q1",
          questionText: "How many households lack a piped water connection?",
          domain: "Water",
          surveyTitle: "Baseline Survey",
          unanswered: 2,
          ofResponses: 3,
          unansweredPct: 66.7,
        },
      ],
      note: "2 of 24 required answers are missing across 3 submitted response(s).",
    },
    invalidResponses: {
      excludedSubmitted: 1,
      abandonedSessions: abandonment.abandoned,
      total: 1 + abandonment.abandoned,
      basis: "1 excluded submitted response(s) + 2 abandoned/incomplete session(s) = the invalid-response count.",
    },
  };
}
