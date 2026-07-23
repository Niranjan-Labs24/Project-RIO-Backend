import { describe, expect, it } from "vitest";
import { MockReportApiClient } from "../providers/mock-report-api.client";
import { MockReportDataProvider } from "../providers/mock-report-data.provider";
import type {
  ExecutiveReportContent,
  RegionReportContent,
  SectorReportContent,
} from "../report-content.types";
import { collectiveGenerator } from "./collective.generator";
import { executiveGenerator } from "./executive.generator";
import { regionGenerator } from "./region.generator";
import { sectorGenerator } from "./sector.generator";
import { sharingStatusGenerator } from "./sharing-status.generator";
import type { GeneratorCtx } from "./index";

function ctx(over: Partial<GeneratorCtx> = {}): GeneratorCtx {
  return {
    provider: new MockReportDataProvider(new MockReportApiClient()),
    orgId: "org-1",
    studyId: "study-1",
    filters: {},
    ...over,
  };
}

describe("sectorGenerator (RPT04)", () => {
  it("emits domain-level severity through the provider seam", async () => {
    const { title, content } = await sectorGenerator(ctx());
    const c = content as unknown as SectorReportContent;
    expect(title).toContain("Domain-wise Needs Report");
    expect(c.domains.some((d) => d.name === "Water & Sanitation")).toBe(true);
    expect(c.header.methodologyVersion).toBe("v1.0");
  });

  it("snapshots filters", async () => {
    const { content } = await sectorGenerator(ctx({ filters: { domain: "Health" } }));
    expect((content as unknown as SectorReportContent).filters).toEqual({ domain: "Health" });
  });
});

describe("regionGenerator (RPT06)", () => {
  it("emits per-region priority through the provider seam", async () => {
    const { title, content } = await regionGenerator(ctx());
    const c = content as unknown as RegionReportContent;
    expect(title).toContain("Regional Needs Report");
    expect(c.regions.length).toBeGreaterThan(0);
    expect(c.regions[0]).toHaveProperty("priorityStatus");
  });
});

describe("executiveGenerator (RPT13)", () => {
  it("emits top priorities + structured AI summary + anomalies", async () => {
    const { title, content } = await executiveGenerator(ctx());
    const c = content as unknown as ExecutiveReportContent;
    expect(title).toContain("Executive Summary");
    expect(c.topPriorities.length).toBeGreaterThan(0);
    expect(c.aiSummary).toHaveProperty("executiveSummary");
    expect(Array.isArray(c.anomalies)).toBe(true);
  });

  it("rejects when studyId is missing (study-scoped)", async () => {
    await expect(executiveGenerator(ctx({ studyId: undefined }))).rejects.toMatchObject({
      response: { error: { code: "STUDY_ID_REQUIRED" } },
    });
  });
});

describe("collectiveGenerator (RPT02)", () => {
  it("emits cross-study KPIs, scoring distribution, and an AI summary", async () => {
    const { title, content } = await collectiveGenerator(ctx({ studyId: undefined }));
    const c = content as Record<string, unknown>;
    expect(title).toContain("Collective Report");
    expect((c.kpis as { needCount: number }).needCount).toBeGreaterThan(0);
    // SLA compliance is present but null until reviewer-sla is wired.
    expect((c.kpis as { slaCompliancePct: number | null }).slaCompliancePct).toBeNull();
    expect(Array.isArray(c.scoringDistribution)).toBe(true);
    expect(c.aiSummary).toHaveProperty("executiveSummary");
  });
});

describe("sharingStatusGenerator (RPT12)", () => {
  it("emits sharing requests and a status tally", async () => {
    const { title, content } = await sharingStatusGenerator(ctx({ studyId: undefined }));
    const c = content as Record<string, unknown>;
    expect(title).toBe("Report Sharing Status");
    expect((c.summary as { approved: number }).approved).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(c.requests)).toBe(true);
    expect((c.requests as unknown[]).length).toBeGreaterThan(0);
  });
});
