import { describe, expect, it } from "vitest";
import { MockReportApiClient } from "../providers/mock-report-api.client";
import { MockReportDataProvider } from "../providers/mock-report-data.provider";
import type { VillageReportContent } from "../report-content.types";
import { villageGenerator } from "./village.generator";
import type { GeneratorCtx } from "./index";

function ctx(over: Partial<GeneratorCtx> = {}): GeneratorCtx {
  return {
    provider: new MockReportDataProvider(new MockReportApiClient()),
    orgId: "org-1",
    studyId: "study-1",
    studyTitle: "Water Assessment",
    filters: { villageId: "Village A" },
    ...over,
  };
}

describe("villageGenerator (RPT14)", () => {
  it("titles the report from the selected village name", async () => {
    const { title } = await villageGenerator(ctx());
    expect(title).toBe("Village Report — Village A");
  });

  it("echoes the selected village and study title into the content", async () => {
    const { content } = await villageGenerator(ctx());
    const c = content as unknown as VillageReportContent;
    expect(c.village.name).toBe("Village A");
    expect(c.header.studyName).toBe("Water Assessment");
  });

  it("emits the RPT-2026-001 content shape verbatim (reconcile invariant)", async () => {
    const { content } = await villageGenerator(ctx());
    const c = content as unknown as VillageReportContent;

    // Numbers are supplied by the provider, never computed in the report layer.
    expect(c.priority.villagePriorityScore).toBe(37.45);
    expect(c.priority.priorityStatus).toBe("HIGH");
    expect(c.priority.overrideApplied).toBe(true);
    const water = c.severity.domains.find((d) => d.name === "Water & Sanitation");
    expect(water?.severityScore).toBe(81);
    expect(water?.confidence).toBe("LOW");
    expect(c.severity.overallVillageNeedsIndex).toBe(63.8);
    expect(c.topKpis[0]?.kpi).toBe("Daily Clean Water Access");
    expect(c.aiSummary.recommendations).toHaveLength(3);
    expect(c.approval.reviewerApprovedBy).toBe("Reviewer - Demo User");
  });

  it("snapshots the applied filters into content", async () => {
    const { content } = await villageGenerator(ctx({ filters: { villageId: "VIL-001", region: "R1" } }));
    const c = content as unknown as VillageReportContent;
    expect(c.filters).toEqual({ villageId: "VIL-001", region: "R1" });
  });

  it("rejects when studyId is missing", async () => {
    await expect(villageGenerator(ctx({ studyId: undefined }))).rejects.toMatchObject({
      response: { error: { code: "STUDY_ID_REQUIRED" } },
    });
  });

  it("rejects when filters.villageId is missing or blank", async () => {
    await expect(villageGenerator(ctx({ filters: {} }))).rejects.toMatchObject({
      response: { error: { code: "VILLAGE_ID_REQUIRED" } },
    });
    await expect(villageGenerator(ctx({ filters: { villageId: "  " } }))).rejects.toMatchObject({
      response: { error: { code: "VILLAGE_ID_REQUIRED" } },
    });
  });
});
