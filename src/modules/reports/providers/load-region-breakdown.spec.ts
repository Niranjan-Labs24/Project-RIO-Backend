import { describe, expect, it } from "vitest";
import { loadRegionBreakdown } from "./load-region-breakdown";
import type { TenantPrismaService } from "../../../tenancy/tenant-prisma.service";

// RPT06 must be REGION-scoped. The report previously read the study-wide
// rollup and printed it under a region's name, so two regions in one study
// reported identical figures. These assert the resolution chain the schema
// forces — Region -> Governorate -> Need -> village -> rollup — and the
// reporting of what could not be attributed.

const RIYADH = { id: "gov-1", code: "0101", name: "Riyadh", regionId: "region-1", region: { id: "region-1", name: "Riyadh Region" } };
const KHARJ = { id: "gov-2", code: "0102", name: "Al Kharj", regionId: "region-1", region: { id: "region-1", name: "Riyadh Region" } };
const MAKKAH = { id: "gov-3", code: "0201", name: "Jeddah", regionId: "region-2", region: { id: "region-2", name: "Makkah Region" } };

const NEEDS = [
  { id: "n1", village: ["Al Jumum North"], needGovernorates: [{ governorate: RIYADH }] },
  { id: "n2", village: ["Al Daer Central"], needGovernorates: [{ governorate: RIYADH }] },
  { id: "n3", village: ["Kharj Village"], needGovernorates: [{ governorate: KHARJ }] },
  { id: "n4", village: ["Jeddah Village"], needGovernorates: [{ governorate: MAKKAH }] },
  // No governorate link at all — a real need that cannot be attributed.
  { id: "n5", village: ["Orphan Village"], needGovernorates: [] },
  // Inside Riyadh but never scored, so the mean below has something real to
  // exclude. Without this the exclusion test passes trivially.
  { id: "n6", village: ["Riyadh Unscored"], needGovernorates: [{ governorate: RIYADH }] },
];

const ROLLUPS = [
  { villageId: "Al Jumum North", severityScore: 80, validResponseCount: 20 },
  { villageId: "Al Daer Central", severityScore: 40, validResponseCount: 10 },
  { villageId: "Kharj Village", severityScore: 55, validResponseCount: 8 },
  { villageId: "Jeddah Village", severityScore: 90, validResponseCount: 30 },
  // "Orphan Village" deliberately absent — named on a need, never scored.
];

const ASSESSMENTS = [
  { villageId: "Al Jumum North", priorityScore: 30, priorityStatus: "HIGH" },
  { villageId: "Al Daer Central", priorityScore: 60, priorityStatus: "MEDIUM" },
  { villageId: "Kharj Village", priorityScore: 50, priorityStatus: "MEDIUM" },
  { villageId: "Jeddah Village", priorityScore: 20, priorityStatus: "HIGH" },
];

const RESPONSES = [
  ...Array.from({ length: 20 }, () => ({ village: ["Al Jumum North"] })),
  ...Array.from({ length: 10 }, () => ({ village: ["Al Daer Central"] })),
  ...Array.from({ length: 8 }, () => ({ village: ["Kharj Village"] })),
  ...Array.from({ length: 30 }, () => ({ village: ["Jeddah Village"] })),
];

function fakeTenant(): TenantPrismaService {
  const inFilter = <T extends { villageId: string }>(rows: T[], args: { where: { villageId?: { in: string[] } } }) =>
    rows.filter((r) => args.where.villageId?.in.includes(r.villageId) ?? true);

  const tx = {
    need: { findMany: async () => NEEDS },
    scoreRollup: { findMany: async (args: never) => inFilter(ROLLUPS, args) },
    villagePriorityAssessment: { findMany: async (args: never) => inFilter(ASSESSMENTS, args) },
    surveyResponse: { findMany: async () => RESPONSES },
  };
  return {
    runInOrgContext: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as TenantPrismaService;
}

const query = { studyId: "s1", surveyId: "sv1", methodologyVersionId: "mv1" };

describe("loadRegionBreakdown", () => {
  it("returns only the requested region's governorates", async () => {
    const out = await loadRegionBreakdown(fakeTenant(), { ...query, regionId: "region-1" });
    const names = out.governorates.map((g) => g.governorate);
    expect(names).toContain("Riyadh");
    expect(names).toContain("Al Kharj");
    // Jeddah belongs to Makkah Region. Its presence would mean the filter did
    // nothing — the exact defect this replaced.
    expect(names).not.toContain("Jeddah");
    expect(out.regionName).toBe("Riyadh Region");
  });

  it("gives two governorates in the same region different figures", async () => {
    const out = await loadRegionBreakdown(fakeTenant(), { ...query, regionId: "region-1" });
    const riyadh = out.governorates.find((g) => g.governorate === "Riyadh")!;
    const kharj = out.governorates.find((g) => g.governorate === "Al Kharj")!;

    // Riyadh: villages at 80 and 40, so the cross-village mean is 60.
    expect(riyadh.severityScore).toBe(60);
    expect(kharj.severityScore).toBe(55);
    expect(riyadh.severityScore).not.toBe(kharj.severityScore);
  });

  it("carries the worst village beside the mean", async () => {
    const out = await loadRegionBreakdown(fakeTenant(), { ...query, regionId: "region-1" });
    const riyadh = out.governorates.find((g) => g.governorate === "Riyadh")!;
    // Averaging 60 while containing an 80 is exactly the masking the
    // methodology's no-masking rule exists to surface.
    expect(riyadh.maxVillageSeverity).toBe(80);
    expect(riyadh.maxVillageSeverity!).toBeGreaterThan(riyadh.severityScore!);
  });

  it("attributes responses to the village that submitted them", async () => {
    const out = await loadRegionBreakdown(fakeTenant(), { ...query, regionId: "region-1" });
    const riyadh = out.governorates.find((g) => g.governorate === "Riyadh")!;
    // 20 + 10, not the study's whole 68.
    expect(riyadh.responseCount).toBe(30);
  });

  it("reports needs that could not be attributed rather than dropping them", async () => {
    const out = await loadRegionBreakdown(fakeTenant(), query);
    // n5 has no governorate link. Silently excluding it would make a partial
    // region read as a complete one.
    expect(out.unmappedNeedCount).toBe(1);
  });

  it("lists villages that have no score instead of scoring them zero", async () => {
    const out = await loadRegionBreakdown(fakeTenant(), query);
    expect(out.unscoredVillages).toContain("Orphan Village");
    const orphan = out.villages.find((v) => v.village === "Orphan Village")!;
    // Null, never 0: a village nobody could measure is not a village with no need.
    expect(orphan.severityScore).toBeNull();
  });

  it("excludes unscored villages from the mean rather than dragging it down", async () => {
    const out = await loadRegionBreakdown(fakeTenant(), { ...query, regionId: "region-1" });
    const riyadh = out.governorates.find((g) => g.governorate === "Riyadh")!;
    // Riyadh holds three villages: 80, 40, and one never scored. The mean is
    // 60 over the two that were measured — counting the third as 0 would
    // report 40 and understate the need.
    expect(riyadh.villageCount).toBe(3);
    expect(riyadh.severityScore).toBe(60);
    expect(out.unscoredVillages).toContain("Riyadh Unscored");
  });

  it("sorts worst-first, with unscored villages last", async () => {
    const out = await loadRegionBreakdown(fakeTenant(), query);
    const scored = out.villages.filter((v) => v.severityScore !== null).map((v) => v.severityScore!);
    expect(scored).toEqual([...scored].sort((a, b) => b - a));
    // An unscored village sorted to the top would read as the worst finding.
    expect(out.villages[out.villages.length - 1]!.severityScore).toBeNull();
  });

  it("covers every governorate in the study when no region is named", async () => {
    const out = await loadRegionBreakdown(fakeTenant(), query);
    const names = out.governorates.map((g) => g.governorate);
    expect(names).toEqual(expect.arrayContaining(["Riyadh", "Al Kharj", "Jeddah"]));
  });
});
