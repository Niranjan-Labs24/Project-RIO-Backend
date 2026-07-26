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
// Village/sector/etc. paths never touch priorityV2 — a no-op stub is enough.
const noPriority = { listForOrg: async () => [] };
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
    const provider = new ReportSummaryDataProvider(summary as never, fakeTenant as never, fallback, noPriority as never);

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
    const provider = new ReportSummaryDataProvider(summary as never, fakeTenant as never, fallback, noPriority as never);

    const c = (await provider.getVillageReport(query)) as unknown as VillageReportContent;
    // Mock narrative (not the real "AI narrative here."), village echoed from filter.
    expect(c.aiSummary.executiveSummary).toContain("High Priority status");
    expect(c.village.name).toBe("Ad-Dilam");
  });
});

// A tenant whose tx returns the given fixtures for the collective-dashboard queries.
function collectiveTenant(fx: {
  needCount: number;
  needs: unknown[];
  quality: unknown[];
  decisions: unknown[];
  users: unknown[];
}) {
  const tx = {
    need: { count: async () => fx.needCount, findMany: async () => fx.needs },
    responseQualityResult: { findMany: async () => fx.quality },
    aiDecision: { findMany: async () => fx.decisions },
    user: { findMany: async () => fx.users },
  };
  return { runInOrgContext: <T>(fn: (t: unknown) => Promise<T>) => fn(tx) };
}

describe("ReportSummaryDataProvider.getCollectiveDashboard", () => {
  const summaryStub = {} as never;

  it("aggregates REAL needs, scoring distribution, top priorities, anomalies and reviewer notes", async () => {
    const priorityV2 = {
      listForOrg: async () => [
        { studyId: "st1", studyTitle: "Water Study", needId: "n1", score: { overallScore: 30, level: "high", gapType: null, scoredAt: "2026-07-22T00:00:00Z" } },
        { studyId: "st1", studyTitle: "Water Study", needId: "n2", score: { overallScore: 80, level: "low", gapType: null, scoredAt: "2026-07-22T00:00:00Z" } },
        { studyId: "st1", studyTitle: "Water Study", needId: "n3", score: null }, // unscored — counted in needCount, not in distribution
      ],
    };
    const tenant = collectiveTenant({
      needCount: 3,
      needs: [
        { id: "n1", statement: "Clean water access", title: "W", domain: "Water & Sanitation", village: ["Ad-Dilam"], studyId: "st1" },
        { id: "n2", statement: "School supplies", title: "E", domain: "Education", village: [], studyId: "st1" },
        { id: "n3", statement: "Unscored need", title: "U", domain: null, village: [], studyId: "st1" },
      ],
      quality: [
        { confidenceFlag: "low", isDuplicate: false },
        { confidenceFlag: "standard", isDuplicate: true },
      ],
      decisions: [
        { humanDecision: { decision: "modified", notes: "Validate water access." }, decidedBy: "u1", decidedAt: new Date("2026-07-22T10:20:00Z") },
        { humanDecision: { decision: "approved", notes: null }, decidedBy: "u2", decidedAt: new Date("2026-07-21T10:20:00Z") }, // no note → excluded
      ],
      users: [{ id: "u1", name: "Reviewer Demo" }],
    });
    const provider = new ReportSummaryDataProvider(summaryStub, tenant as never, fallback, priorityV2 as never);

    const d = await provider.getCollectiveDashboard(query);

    expect(d.needCount).toBe(3);
    expect(d.scoringDistribution).toEqual([
      { band: "High", count: 1 },
      { band: "Medium", count: 0 },
      { band: "Low", count: 1 },
    ]);
    // Most-urgent first; severity = 100 − priorityScore; entity from village.
    expect(d.topPriorities[0]).toEqual({ rank: 1, label: "Clean water access", domain: "Water & Sanitation", severityScore: 70, entity: "Ad-Dilam" });
    // No village → falls back to the study title as the entity.
    expect(d.topPriorities[1]).toMatchObject({ rank: 2, label: "School supplies", domain: "Education", severityScore: 20, entity: "Water Study" });
    expect(d.anomalies).toEqual([
      { severity: "warning", note: "1 response(s) flagged Low Confidence — findings should be field-validated." },
      { severity: "info", note: "1 potential duplicate response(s) detected." },
    ]);
    expect(d.reviewerNotes).toEqual([
      { author: "Reviewer Demo", note: "Validate water access.", at: "2026-07-22T10:20:00.000Z" },
    ]);
    expect(d.trends).toHaveLength(1);
    // Not the mock fixtures.
    expect(d.needCount).not.toBe(24);
  });

  it("returns real zeros (not the Sample-Village mock) for an org with no needs", async () => {
    const priorityV2 = { listForOrg: async () => [] };
    const tenant = collectiveTenant({ needCount: 0, needs: [], quality: [], decisions: [], users: [] });
    const provider = new ReportSummaryDataProvider(summaryStub, tenant as never, fallback, priorityV2 as never);

    const d = await provider.getCollectiveDashboard(query);

    expect(d).toEqual({ needCount: 0, scoringDistribution: [], topPriorities: [], trends: [], anomalies: [], reviewerNotes: [] });
  });

  it("falls back to the mock when the aggregation throws", async () => {
    const priorityV2 = {
      listForOrg: async () => {
        throw new Error("db down");
      },
    };
    const tenant = collectiveTenant({ needCount: 0, needs: [], quality: [], decisions: [], users: [] });
    const provider = new ReportSummaryDataProvider(summaryStub, tenant as never, fallback, priorityV2 as never);

    const d = await provider.getCollectiveDashboard(query);
    // Mock fixture value proves the fallback path ran.
    expect(d.needCount).toBe(24);
  });
});
