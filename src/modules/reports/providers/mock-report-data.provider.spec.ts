import { describe, expect, it } from "vitest";
import { MockReportApiClient } from "./mock-report-api.client";
import { MockReportDataProvider } from "./mock-report-data.provider";

// Step 0 gate: the provider seam returns the RPT-2026-001 mock shape and the
// SLA/demographics stubs behave as designed. When the real provider lands,
// these same assertions become reconcile checks against real analytics rows.
describe("MockReportDataProvider", () => {
  const provider = new MockReportDataProvider(new MockReportApiClient());
  const base = { orgId: "org-1", studyId: "study-1", filters: { villageId: "VIL-001" } };

  it("returns the RPT-2026-001 village shape verbatim", async () => {
    const c = await provider.getVillageReport({ ...base, villageId: "VIL-001" });

    expect(c.priority.villagePriorityScore).toBe(37.45);
    expect(c.priority.priorityStatus).toBe("HIGH");
    expect(c.priority.overrideApplied).toBe(true);
    expect(c.priority.overrideReason).toContain("Water & Sanitation performance score is 19");

    const water = c.severity.domains.find((d) => d.name === "Water & Sanitation");
    expect(water?.severityScore).toBe(81);
    expect(water?.confidence).toBe("LOW");
    expect(water?.isCriticalDomain).toBe(true);
    expect(water?.validResponseCount).toBe(8);

    expect(c.severity.overallVillageNeedsIndex).toBe(63.8);
    expect(c.topKpis[0]?.kpi).toBe("Daily Clean Water Access");
    expect(c.topKpis[0]?.severityScore).toBe(88);
    expect(c.aiSummary.recommendations).toHaveLength(3);
    expect(c.approval.reviewerApprovedBy).toBe("Reviewer - Demo User");
  });

  it("snapshots the applied filters into content (reconcile guarantee)", async () => {
    const c = await provider.getVillageReport({ ...base, villageId: "VIL-001" });
    expect(c.filters).toEqual({ villageId: "VIL-001" });
  });

  it("carries an SLA field on collective KPIs (null until reviewer-sla wired)", async () => {
    const kpis = await provider.getCollectiveKpis(base);
    expect(kpis).toHaveProperty("slaCompliancePct");
    expect(kpis.slaCompliancePct).toBeNull();
    expect(kpis.needCount).toBeGreaterThan(0);
  });

  it("returns null demographics until capture ships (drives 'Not available' charts)", async () => {
    await expect(provider.getDemographics(base)).resolves.toBeNull();
  });

  it("provides sector/region/executive shapes for later steps", async () => {
    await expect(provider.getSectorReport(base)).resolves.toHaveProperty("domains");
    await expect(provider.getRegionReport(base)).resolves.toHaveProperty("regions");
    await expect(provider.getExecutiveReport(base)).resolves.toHaveProperty("topPriorities");
  });
});
