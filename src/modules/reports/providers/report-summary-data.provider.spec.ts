import { describe, expect, it } from "vitest";
import type { VillageReportContent } from "../report-content.types";
import type { ReportDataSnapshot } from "../report-summary.service";
import { ReportSummaryDataProvider } from "./report-summary-data.provider";

function snapshot(overrides: Partial<ReportDataSnapshot["severity"] & ReportDataSnapshot["priority"]> = {}): ReportDataSnapshot {
  return {
    snapshotId: "s", generatedAt: "2026-07-22T10:30:00Z", scope: "VILLAGE", scopeFilters: {},
    study: { studyId: "study-1", studyName: "Water Assessment", surveyId: "srv-1", villageId: "VIL-1", villageName: "Ad-Dilam", assessmentCycle: 1, organizationName: "Demo NGO", methodologyVersionId: "mv", governorateName: "Riyadh", regionName: "Riyadh Region", population: 5000, requiredSampleSize: 94, minimumDetectableEffect: 14.4 },
    responseQuality: { submittedResponseCount: 42, validResponseCount: 38, dontKnowRate: 12.4, confidenceLevel: "STANDARD", confidenceReason: "High response completeness.", dontKnowBand: "moderate" },
    severity: {
      overallVillageNeedsIndex: 63.8, severityBand: "Medium",
      domainSeverityScores: [{ domainKey: "HEALTH", domainName: "Health", severityScore: 72, confidenceLevel: "STANDARD", validResponseCount: 35, excludedResponseCount: 3, dontKnowRate: 0.05, kpiCount: 6 }],
      topKpis: [{ rank: 1, kpiName: "Water Access", indicatorName: "I1", domainName: "Water", severityScore: 88, confidenceLevel: "LOW", validResponseCount: 8 }],
      subDomainSeverityScores: [],
      indicatorSeverityScores: [],
      kpiSeverityScores: [],
      ...(overrides.overallVillageNeedsIndex !== undefined ? { overallVillageNeedsIndex: overrides.overallVillageNeedsIndex } : {}),
    },
    priority: {
      villagePriorityScore: 37.45, priorityStatus: "HIGH",
      domainPerformanceScores: [{ domainKey: "HEALTH", domainName: "Health", severityScore: 72, performanceScore: 28, weight: 0.3, weightedContribution: 8.4, isCriticalDomain: true, triggeredOverride: false }],
      overrideApplied: false, overrideReason: null, calculatedAt: "2026-07-22T09:00:00Z",
      ...(overrides.villagePriorityScore !== undefined ? { villagePriorityScore: overrides.villagePriorityScore } : {}),
    },
    questionsAskedByDomain: [{ domain: "Health", domainKey: "HEALTH", count: 12 }],
    unitGeo: null,
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

// Village/sector/etc. paths never touch these — no-op stubs are enough.
const noPriority = { listForOrg: async () => [] };
const noSharing = { list: async () => [] };
const noSla = { listAlerts: async () => [] };
// RPT10 only — the village/sector/etc. paths under test never load sessions.
const noSessions = { loadSessionsForReport: async () => [], idleMinutes: 120 };
// RIO-AI-003: no confirmed summary, so RPT01/RPT15 fall back to the raw
// statement — which is what every assertion in this file already expects.
const noNeedSummary = { getConfirmedTextForNeed: async () => null };
const query = { studyId: "study-1", villageId: "Ad-Dilam", orgId: "o", filters: {} };

function makeProvider(
  summary: unknown,
  tenant: unknown,
  priorityV2: unknown = noPriority,
  sharing: unknown = noSharing,
  sla: unknown = noSla,
  sessions: unknown = noSessions,
  needSummaries: unknown = noNeedSummary,
): ReportSummaryDataProvider {
  return new ReportSummaryDataProvider(
    summary as never, tenant as never, priorityV2 as never, sharing as never, sla as never,
    sessions as never, needSummaries as never,
  );
}

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
    const provider = makeProvider(summary, fakeTenant);

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

  it("raises STUDY_NOT_SCORED (409) instead of serving fixtures when the study has no scores yet", async () => {
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
    const provider = makeProvider(summary, fakeTenant);

    await expect(provider.getVillageReport(query)).rejects.toMatchObject({
      status: 409,
      response: { error: { code: "STUDY_NOT_SCORED" } },
    });
  });

  it("propagates an infrastructure failure rather than masking it as a report", async () => {
    const summary = {
      getSummary: async () => {
        throw new Error("db down");
      },
    };
    const provider = makeProvider(summary, fakeTenant);

    await expect(provider.getVillageReport(query)).rejects.toThrow("db down");
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

const populatedPriority = {
  listForOrg: async () => [
    { studyId: "st1", studyTitle: "Water Study", needId: "n1", score: { overallScore: 30, level: "high", gapType: null, scoredAt: "2026-07-22T00:00:00Z" } },
    { studyId: "st1", studyTitle: "Water Study", needId: "n2", score: { overallScore: 80, level: "low", gapType: null, scoredAt: "2026-07-22T00:00:00Z" } },
    { studyId: "st1", studyTitle: "Water Study", needId: "n3", score: null }, // unscored — counted in needCount, not in distribution
  ],
};

function populatedTenant() {
  return collectiveTenant({
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
}

describe("ReportSummaryDataProvider.getCollectiveDashboard", () => {
  const summaryStub = {};

  it("aggregates REAL needs, scoring distribution, top priorities, anomalies and reviewer notes", async () => {
    const provider = makeProvider(summaryStub, populatedTenant(), populatedPriority);

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
  });

  it("returns real zeros for an org with no needs", async () => {
    const tenant = collectiveTenant({ needCount: 0, needs: [], quality: [], decisions: [], users: [] });
    const provider = makeProvider(summaryStub, tenant, { listForOrg: async () => [] });

    const d = await provider.getCollectiveDashboard(query);

    expect(d).toEqual({ needCount: 0, scoringDistribution: [], topPriorities: [], trends: [], anomalies: [], reviewerNotes: [] });
  });

  it("propagates when the aggregation throws instead of returning fixtures", async () => {
    const priorityV2 = {
      listForOrg: async () => {
        throw new Error("db down");
      },
    };
    const tenant = collectiveTenant({ needCount: 0, needs: [], quality: [], decisions: [], users: [] });
    const provider = makeProvider(summaryStub, tenant, priorityV2);

    await expect(provider.getCollectiveDashboard(query)).rejects.toThrow("db down");
  });
});

describe("ReportSummaryDataProvider.getCollectiveReport (RPT02)", () => {
  it("derives KPIs from the REAL aggregate and the REAL reviewer-SLA queue", async () => {
    // 4 alerts, 1 breached → 75% compliance.
    const sla = {
      listAlerts: async () => [
        { status: "breached" }, { status: "at_risk" }, { status: "pending" }, { status: "pending" },
      ],
    };
    const provider = makeProvider({}, populatedTenant(), populatedPriority, noSharing, sla);

    const c = await provider.getCollectiveReport({ orgId: "o", filters: {} });

    expect(c.kpis).toEqual({ needCount: 3, slaCompliancePct: 75 });
    expect(c.scoringDistribution).toEqual([
      { band: "High", count: 1 },
      { band: "Medium", count: 0 },
      { band: "Low", count: 1 },
    ]);
    // Narrative is stated from the real numbers, not a canned paragraph.
    expect(c.aiSummary.executiveSummary).toContain("3 need(s) recorded");
    expect(c.aiSummary.executiveSummary).toContain("1 are High priority");
    expect(c.aiSummary.keyFindings).toContain("Clean water access");
    expect(c.aiSummary.recommendations).toContain("Clear the overdue reviewer queue — SLA compliance is 75%.");
  });

  it("says so plainly when the org has no needs", async () => {
    const tenant = collectiveTenant({ needCount: 0, needs: [], quality: [], decisions: [], users: [] });
    const provider = makeProvider({}, tenant, { listForOrg: async () => [] });

    const c = await provider.getCollectiveReport({ orgId: "o", filters: {} });

    expect(c.kpis).toEqual({ needCount: 0, slaCompliancePct: null });
    expect(c.aiSummary.executiveSummary).toBe("No needs have been recorded for this organisation yet.");
    expect(c.aiSummary.recommendations).toEqual([]);
  });
});

describe("ReportSummaryDataProvider.getSharingStatus (RPT12)", () => {
  it("maps REAL sharing requests and tallies them by status", async () => {
    const sharing = {
      list: async () => [
        { reportTitle: "Village Report — Ad-Dilam", requestingOrgName: "Riverside Trust", ownerOrgName: "Demo NGO", status: "approved", requestedAt: "2026-07-20T09:00:00Z", decidedAt: "2026-07-21T10:00:00Z" },
        { reportTitle: "Executive Summary", requestingOrgName: "Riverside Trust", ownerOrgName: "Demo NGO", status: "pending", requestedAt: "2026-07-22T08:30:00Z", decidedAt: null },
        { reportTitle: "Regional Report", requestingOrgName: "Other NGO", ownerOrgName: "Demo NGO", status: "rejected", requestedAt: "2026-07-19T08:30:00Z", decidedAt: "2026-07-19T12:00:00Z" },
      ],
    };
    const provider = makeProvider({}, fakeTenant, noPriority, sharing);

    const c = await provider.getSharingStatus({ orgId: "o", filters: {} });

    expect(c.summary).toEqual({ approved: 1, pending: 1, rejected: 1 });
    expect(c.requests).toHaveLength(3);
    expect(c.requests[0]).toEqual({
      reportTitle: "Village Report — Ad-Dilam",
      requestingOrg: "Riverside Trust",
      ownerOrg: "Demo NGO",
      status: "approved",
      requestedAt: "2026-07-20T09:00:00Z",
      decidedAt: "2026-07-21T10:00:00Z",
    });
  });

  it("returns an empty log rather than sample rows when nothing has been shared", async () => {
    const provider = makeProvider({}, fakeTenant);

    const c = await provider.getSharingStatus({ orgId: "o", filters: {} });

    expect(c.summary).toEqual({ approved: 0, pending: 0, rejected: 0 });
    expect(c.requests).toEqual([]);
  });
});
