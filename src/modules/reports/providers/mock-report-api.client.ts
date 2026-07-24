import { Injectable } from "@nestjs/common";
import type {
  CollectiveDashboardData,
  CollectiveKpis,
  CollectiveReportContent,
  Demographics,
  ExecutiveReportContent,
  RegionReportContent,
  SectorReportContent,
  SharingStatusContent,
  VillageReportContent,
} from "../report-content.types";
import type { ScopedReportQuery, VillageReportQuery } from "./report-data.provider";

// Serves the team's AI-summary mock (RPT-2026-001) behind a CALL rather than a
// static import. That indirection is the whole point: "wire real data" later
// is re-pointing this client (base URL / real fetch), not touching any
// generator or provider. Today it returns in-memory fixtures shaped exactly
// like the eventual API response.
//
// TODO(RIO-Reports): replace the in-memory fixtures below with a real fetch()
// to the analytics/AI endpoint once it exists. Signatures stay identical.
@Injectable()
export class MockReportApiClient {
  async fetchVillageReport(query: VillageReportQuery): Promise<VillageReportContent> {
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
        dontKnowRate: 12.4,
      },
      severity: {
        overallVillageNeedsIndex: 63.8,
        label: "Medium",
        domains: [
          { name: "Health", severityScore: 72, performanceScore: 28, weight: 0.3, weightedContribution: 8.4, confidence: "STANDARD", isCriticalDomain: true },
          { name: "Education", severityScore: 48, performanceScore: 52, weight: 0.25, weightedContribution: 13, confidence: "STANDARD", isCriticalDomain: false },
          { name: "Infrastructure", severityScore: 63, performanceScore: 37, weight: 0.2, weightedContribution: 7.4, confidence: "STANDARD", isCriticalDomain: false },
          { name: "Livelihood", severityScore: 55, performanceScore: 45, weight: 0.15, weightedContribution: 6.75, confidence: "STANDARD", isCriticalDomain: false },
          { name: "Water & Sanitation", severityScore: 81, performanceScore: 19, weight: 0.1, weightedContribution: 1.9, confidence: "LOW", validResponseCount: 8, dontKnowRate: 25, isCriticalDomain: true },
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
        dataQualityNote:
          "Water & Sanitation findings have Low Confidence because only 8 valid responses were available and the Don't Know rate was 25%. These findings should be validated through additional field data collection.",
        trendNote: "Cycle 1 assessment: Trend Pending.",
        recommendations: [
          "Validate water-access findings through additional household responses and local service records.",
          "Assess options to improve safe-water availability and reliability.",
          "Review medicine availability and health-facility access barriers with relevant service providers.",
        ],
      },
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

  async fetchSectorReport(query: ScopedReportQuery): Promise<SectorReportContent> {
    return {
      header: {
        studyName: query.studyTitle ?? "Sector Needs Assessment",
        entityName: null,
        methodologyVersion: "v1.0",
        reportGeneratedAt: "2026-07-22T10:30:00Z",
      },
      domains: [
        { name: "Health", severityScore: 72, performanceScore: 28, weight: 0.3, weightedContribution: 8.4, confidence: "STANDARD", isCriticalDomain: true },
        { name: "Water & Sanitation", severityScore: 81, performanceScore: 19, weight: 0.1, weightedContribution: 1.9, confidence: "LOW", validResponseCount: 8, dontKnowRate: 25, isCriticalDomain: true },
      ],
      overall: {
        overallVillageNeedsIndex: 63.8,
        label: "Medium",
        domains: [],
      },
      aiSummary: {
        executiveSummary: "Health and Water & Sanitation are the highest-severity sectors across the study.",
        keyFindings: "Water & Sanitation shows the highest severity (81) but low confidence.",
        dataQualityNote: "Water & Sanitation confidence is Low pending additional field data.",
        trendNote: "Cycle 1 assessment: Trend Pending.",
        recommendations: ["Prioritise Water & Sanitation interventions.", "Validate low-confidence sector findings."],
      },
      filters: query.filters,
    };
  }

  async fetchRegionReport(query: ScopedReportQuery): Promise<RegionReportContent> {
    return {
      header: {
        studyName: query.studyTitle ?? "Regional Needs Assessment",
        entityName: null,
        methodologyVersion: "v1.0",
        reportGeneratedAt: "2026-07-22T10:30:00Z",
      },
      regions: [
        { regionName: "Sample Region", governorate: "Sample Governorate", priorityScore: 37.45, priorityStatus: "HIGH", needCount: 12 },
      ],
      aiSummary: {
        executiveSummary: "Sample Region shows High priority driven by water and health needs.",
        keyFindings: "One governorate reports 12 needs with High priority status.",
        dataQualityNote: "Regional aggregation is based on approved priority scores.",
        trendNote: "Cycle 1 assessment: Trend Pending.",
        recommendations: ["Focus resources on the highest-priority governorate."],
      },
      filters: query.filters,
    };
  }

  async fetchExecutiveReport(query: ScopedReportQuery): Promise<ExecutiveReportContent> {
    return {
      header: {
        studyName: query.studyTitle ?? "Executive Summary",
        entityName: null,
        methodologyVersion: "v1.0",
        reportGeneratedAt: "2026-07-22T10:30:00Z",
      },
      topPriorities: [
        { rank: 1, kpi: "Daily Clean Water Access", domain: "Water & Sanitation", severityScore: 88, confidence: "LOW", validResponseCount: 8 },
        { rank: 2, kpi: "Availability of Essential Medicines", domain: "Health", severityScore: 78, confidence: "STANDARD", validResponseCount: 35 },
      ],
      responseQuality: {
        submittedResponses: 42,
        validResponses: 38,
        overallConfidence: "STANDARD",
        dontKnowRate: 12.4,
      },
      aiSummary: {
        executiveSummary: "Water and health are the dominant strategic priorities across all entities.",
        keyFindings: "Daily Clean Water Access is the highest-severity KPI at 88.",
        dataQualityNote: "Water findings carry Low Confidence and should be field-validated.",
        trendNote: "Cycle 1 assessment: Trend Pending.",
        recommendations: ["Prioritise water access.", "Validate low-confidence findings."],
      },
      anomalies: ["Water & Sanitation flagged: Low Confidence with a critical-domain override."],
      reviewerNotes: null,
      filters: query.filters,
    };
  }

  async fetchCollectiveKpis(_query: ScopedReportQuery): Promise<CollectiveKpis> {
    return {
      needCount: 24,
      scoringDistribution: [
        { band: "High", count: 8 },
        { band: "Medium", count: 10 },
        { band: "Low", count: 6 },
      ],
      // TODO(RIO-Reports): source from the reviewer-sla module once wired.
      slaCompliancePct: null,
    };
  }

  async fetchCollectiveReport(query: ScopedReportQuery): Promise<CollectiveReportContent> {
    const kpis = await this.fetchCollectiveKpis(query);
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

  async fetchSharingStatus(query: ScopedReportQuery): Promise<SharingStatusContent> {
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

  async fetchCollectiveDashboard(_query: ScopedReportQuery): Promise<CollectiveDashboardData> {
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

  async fetchDemographics(_query: ScopedReportQuery): Promise<Demographics | null> {
    // Demographic capture (gender/rural) is not yet implemented → null, which
    // makes the demographic charts render "Not available" (Step 4).
    return null;
  }
}
