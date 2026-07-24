import { describe, expect, it } from "vitest";
import type { VillageReportContent } from "../report-content.types";
import type { ReportDataSnapshot } from "../report-summary.service";
import { MockReportApiClient } from "./mock-report-api.client";
import { MockReportDataProvider } from "./mock-report-data.provider";
import { ReportSummaryDataProvider } from "./report-summary-data.provider";

function snapshot(overrides: Partial<ReportDataSnapshot["severity"] & ReportDataSnapshot["priority"]> = {}): ReportDataSnapshot {
  return {
    snapshotId: "s", generatedAt: "2026-07-22T10:30:00Z", scope: "VILLAGE", scopeFilters: {},
    study: { studyId: "study-1", studyName: "Water Assessment", surveyId: "srv-1", villageId: "VIL-1", villageName: "Ad-Dilam", assessmentCycle: 1, organizationName: "Demo NGO", methodologyVersionId: "mv" },
    responseQuality: { submittedResponseCount: 42, validResponseCount: 38, dontKnowRate: 12.4, confidenceLevel: "STANDARD", confidenceReason: "" },
    severity: {
      overallVillageNeedsIndex: 63.8, severityBand: "Medium",
      domainSeverityScores: [{ domainKey: "HEALTH", domainName: "Health", severityScore: 72, confidenceLevel: "STANDARD", validResponseCount: 35 }],
      topKpis: [{ rank: 1, kpiName: "Water Access", indicatorName: "I1", domainName: "Water", severityScore: 88, confidenceLevel: "LOW", validResponseCount: 8 }],
      ...(overrides.overallVillageNeedsIndex !== undefined ? { overallVillageNeedsIndex: overrides.overallVillageNeedsIndex } : {}),
    },
    priority: {
      villagePriorityScore: 37.45, priorityStatus: "HIGH",
      domainPerformanceScores: [{ domainKey: "HEALTH", domainName: "Health", severityScore: 72, performanceScore: 28, weight: 0.3, weightedContribution: 8.4, isCriticalDomain: true, triggeredOverride: false }],
      overrideApplied: false, overrideReason: null, calculatedAt: "2026-07-22T09:00:00Z",
      ...(overrides.villagePriorityScore !== undefined ? { villagePriorityScore: overrides.villagePriorityScore } : {}),
    },
    evidence: [],
  };
}

const fakeTenant = {
  runInOrgContext: <T>(fn: (tx: unknown) => Promise<T>) =>
    fn({
      survey: { findFirst: async () => ({ id: "srv-1" }) },
      surveyResponse: {
        groupBy: async () => [
          { gender: "female", _count: 21 },
          { gender: "male", _count: 17 },
        ],
      },
    }),
};

const fallback = new MockReportDataProvider(new MockReportApiClient());
const query = { studyId: "study-1", villageId: "Ad-Dilam", orgId: "o", filters: {} };

describe("ReportSummaryDataProvider", () => {
  it("uses REAL snapshot + AI narrative + real gender when the study is scored", async () => {
    const summary = {
      getSummary: async () => null,
      buildReportDataSnapshot: async () => ({ snapshot: snapshot(), reportDataHash: "h", evidenceHash: "e" }),
      generatePrioritySummary: async () => ({
        summary: { aiOutputJson: { executiveSummary: "AI narrative here.", draftNextSteps: ["Do X"] } },
        snapshot: snapshot(),
      }),
    };
    const provider = new ReportSummaryDataProvider(summary as never, fakeTenant as never, fallback);

    const c = (await provider.getVillageReport(query)) as unknown as VillageReportContent;
    expect(c.village.name).toBe("Ad-Dilam");
    expect(c.header.studyName).toBe("Water Assessment");
    expect(c.severity.overallVillageNeedsIndex).toBe(63.8);
    expect(c.aiSummary.executiveSummary).toBe("AI narrative here.");
    expect(c.aiSummary.recommendations).toEqual(["Do X"]);
    // Real gender aggregation from survey responses.
    expect(c.demographics?.gender).toEqual([
      { label: "Female", count: 21 },
      { label: "Male", count: 17 },
    ]);
  });

  it("falls back to the mock when the study has no scores yet", async () => {
    const summary = {
      getSummary: async () => null,
      // No scores → overallVillageNeedsIndex/villagePriorityScore null.
      buildReportDataSnapshot: async () => ({
        snapshot: snapshot({ overallVillageNeedsIndex: null as never, villagePriorityScore: null as never }),
        reportDataHash: "h",
        evidenceHash: "e",
      }),
      generatePrioritySummary: async () => {
        throw new Error("no data");
      },
    };
    const provider = new ReportSummaryDataProvider(summary as never, fakeTenant as never, fallback);

    const c = (await provider.getVillageReport(query)) as unknown as VillageReportContent;
    // Mock narrative (not the real "AI narrative here."), village echoed from filter.
    expect(c.aiSummary.executiveSummary).toContain("High Priority status");
    expect(c.village.name).toBe("Ad-Dilam");
  });
});
