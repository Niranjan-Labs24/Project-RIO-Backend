import { describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AreaProfilesService } from "./area-profiles.service";
import { orgContext } from "../../tenancy/org-context";
import type { SaveAreaProfileDto } from "./area-profiles.contract";

// In-memory stand-in for the area-profile table and the KSA reference.
function fakePrisma() {
  const rows: Array<Record<string, unknown>> = [];
  const region = { id: "r1", name: "Eastern Province", nameAr: "المنطقة الشرقية" };
  const gov = { id: "g1", name: "Al-Ahsa", nameAr: "الأحساء", regionId: "r1" };
  const centre = { id: "c1", name: "Hofuf", nameAr: "الهفوف", governorateId: "g1", governorate: gov };
  const find = <T extends { id: string }>(list: T[]) => async ({ where }: { where: { id: string } }) => list.find((x) => x.id === where.id) ?? null;
  return {
    rows,
    areaProfile: {
      findMany: async () => rows,
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      delete: async ({ where }: { where: { id: string } }) => void rows.splice(rows.findIndex((r) => r.id === where.id), 1),
      upsert: async ({ where, create }: { where: { unitKey_year: { unitKey: string; year: number } }; create: Record<string, unknown> }) => {
        const i = rows.findIndex((r) => r.unitKey === where.unitKey_year.unitKey && r.year === where.unitKey_year.year);
        const row = { ...create, id: i >= 0 ? rows[i]!.id : `p${rows.length + 1}`, updatedAt: new Date("2026-10-23T10:00:00Z") };
        if (i >= 0) rows[i] = row;
        else rows.push(row);
        return row;
      },
    },
    region: { findMany: async () => [region], findUnique: find([region]) },
    governorate: { findMany: async () => [gov], findUnique: find([gov]) },
    center: { findMany: async () => [centre], findUnique: find([centre]) },
  };
}

const figures = { year: 2022, population: 1_200_000, growthRatePct: 2.1, densityPerKm2: 9, malePct: 51, femalePct: 49, saudiPct: 80, ruralPct: 20, source: " GASTAT " };
const as = <T>(fn: () => Promise<T>) => orgContext.run({ requestId: "t", actorId: "sysadmin" }, fn);

describe("AreaProfilesService", () => {
  it("saves one row per area and year, replacing it on a second save", async () => {
    const prisma = fakePrisma();
    const svc = new AreaProfilesService(prisma as never);
    const first = await as(() => svc.save({ ...figures, level: "GOVERNORATE", governorateId: "g1" } as SaveAreaProfileDto));
    expect(first).toMatchObject({ unitKey: "GOVERNORATE:g1", unitName: "Al-Ahsa", unitNameAr: "الأحساء", regionId: "r1", source: "GASTAT" });
    await as(() => svc.save({ ...figures, population: 1_300_000, level: "GOVERNORATE", governorateId: "g1" } as SaveAreaProfileDto));
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({ population: 1_300_000, updatedBy: "sysadmin" });
  });

  it("names each level, the village within its governorate", async () => {
    const svc = new AreaProfilesService(fakePrisma() as never);
    const saved = await as(async () => [
      await svc.save({ ...figures, level: "KINGDOM" } as SaveAreaProfileDto),
      await svc.save({ ...figures, level: "REGION", regionId: "r1" } as SaveAreaProfileDto),
      await svc.save({ ...figures, level: "CENTRE", centerId: "c1" } as SaveAreaProfileDto),
      await svc.save({ ...figures, level: "VILLAGE", governorateId: "g1", villageName: " Al-Jafr " } as SaveAreaProfileDto),
    ]);
    expect(saved.map((r) => [r.unitKey, r.unitName])).toEqual([
      ["KINGDOM", "Kingdom of Saudi Arabia"],
      ["REGION:r1", "Eastern Province"],
      ["CENTRE:c1", "Hofuf"],
      ["VILLAGE:g1:al-jafr", "Al-Jafr"],
    ]);
    expect(saved[3]!.unitNameAr).toBeNull();
  });

  it("refuses an area that is not in the KSA reference, and a village without its governorate", async () => {
    const svc = new AreaProfilesService(fakePrisma() as never);
    for (const body of [
      { level: "REGION", regionId: "nope" },
      { level: "GOVERNORATE" },
      { level: "CENTRE", centerId: "nope" },
      { level: "VILLAGE", governorateId: "g1", villageName: "  " },
    ]) {
      await expect(as(() => svc.save({ ...figures, ...body } as SaveAreaProfileDto))).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("deletes a row, and says so when it does not exist", async () => {
    const prisma = fakePrisma();
    const svc = new AreaProfilesService(prisma as never);
    const row = await as(() => svc.save({ ...figures, level: "KINGDOM" } as SaveAreaProfileDto));
    await svc.remove(row.id);
    expect(prisma.rows).toHaveLength(0);
    await expect(svc.remove(row.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
