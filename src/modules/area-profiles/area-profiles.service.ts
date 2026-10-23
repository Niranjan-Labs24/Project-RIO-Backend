import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { requireActor } from "../../tenancy/org-context";
import { villageUnitKey } from "../reports/core-needs/load-core-needs";
import type { SaveAreaProfileDto } from "./area-profiles.contract";

export interface AreaProfileRow {
  id: string;
  level: string;
  unitKey: string;
  regionId: string | null;
  governorateId: string | null;
  centerId: string | null;
  villageName: string | null;
  /** The area's name (English and Arabic) for the list. */
  unitName: string;
  unitNameAr: string | null;
  year: number;
  population: number | null;
  growthRatePct: number | null;
  densityPerKm2: number | null;
  malePct: number | null;
  femalePct: number | null;
  saudiPct: number | null;
  ruralPct: number | null;
  source: string;
  updatedAt: string;
}

const num = (d: unknown): number | null => (d == null ? null : Number(d));

// Official area figures entered once a year by the platform team — read by
// the Core Needs Report's area profile. Platform-wide reference data, written
// through the owner connection like methodology configuration.
@Injectable()
export class AreaProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<AreaProfileRow[]> {
    const rows = await this.prisma.areaProfile.findMany({ orderBy: [{ level: "asc" }, { year: "desc" }] });
    const [regions, govs, centres] = await Promise.all([
      this.prisma.region.findMany({ select: { id: true, name: true, nameAr: true } }),
      this.prisma.governorate.findMany({ select: { id: true, name: true, nameAr: true } }),
      this.prisma.center.findMany({
        where: { id: { in: rows.map((r) => r.centerId).filter((x): x is string => !!x) } },
        select: { id: true, name: true, nameAr: true },
      }),
    ]);
    const names = new Map([...regions, ...govs, ...centres].map((x) => [x.id, x]));
    return rows.map((r) => {
      const ref =
        r.level === "REGION" ? names.get(r.regionId ?? "") : r.level === "GOVERNORATE" ? names.get(r.governorateId ?? "") : r.level === "CENTRE" ? names.get(r.centerId ?? "") : undefined;
      return {
        id: r.id,
        level: r.level,
        unitKey: r.unitKey,
        regionId: r.regionId,
        governorateId: r.governorateId,
        centerId: r.centerId,
        villageName: r.villageName,
        unitName: r.level === "KINGDOM" ? "Kingdom of Saudi Arabia" : r.level === "VILLAGE" ? (r.villageName ?? "") : (ref?.name ?? ""),
        unitNameAr: r.level === "KINGDOM" ? "المملكة العربية السعودية" : r.level === "VILLAGE" ? null : (ref?.nameAr ?? null),
        year: r.year,
        population: r.population,
        growthRatePct: num(r.growthRatePct),
        densityPerKm2: num(r.densityPerKm2),
        malePct: num(r.malePct),
        femalePct: num(r.femalePct),
        saudiPct: num(r.saudiPct),
        ruralPct: num(r.ruralPct),
        source: r.source,
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  /** Create or replace the figures for one area and year. */
  async save(body: SaveAreaProfileDto): Promise<AreaProfileRow> {
    const unit = await this.resolveUnit(body);
    const data = {
      level: body.level,
      unitKey: unit.unitKey,
      regionId: unit.regionId,
      governorateId: unit.governorateId,
      centerId: unit.centerId,
      villageName: unit.villageName,
      year: body.year,
      population: body.population,
      growthRatePct: body.growthRatePct,
      densityPerKm2: body.densityPerKm2,
      malePct: body.malePct,
      femalePct: body.femalePct,
      saudiPct: body.saudiPct,
      ruralPct: body.ruralPct,
      source: body.source.trim(),
      updatedBy: requireActor(),
    };
    const saved = await this.prisma.areaProfile.upsert({
      where: { unitKey_year: { unitKey: unit.unitKey, year: body.year } },
      create: data,
      update: data,
    });
    return (await this.list()).find((r) => r.id === saved.id)!;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.prisma.areaProfile.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ error: { code: "AREA_PROFILE_NOT_FOUND", message: "Area profile not found." } });
    await this.prisma.areaProfile.delete({ where: { id } });
  }

  /** The unit's key and the ids that identify it, checked against the KSA reference. */
  private async resolveUnit(b: SaveAreaProfileDto) {
    const invalid = (msg: string) => new BadRequestException({ error: { code: "AREA_PROFILE_UNIT_INVALID", message: msg } });
    switch (b.level) {
      case "KINGDOM":
        return { unitKey: "KINGDOM", regionId: null, governorateId: null, centerId: null, villageName: null };
      case "REGION": {
        if (!b.regionId || !(await this.prisma.region.findUnique({ where: { id: b.regionId } }))) throw invalid("Choose a region.");
        return { unitKey: `REGION:${b.regionId}`, regionId: b.regionId, governorateId: null, centerId: null, villageName: null };
      }
      case "GOVERNORATE": {
        const g = b.governorateId ? await this.prisma.governorate.findUnique({ where: { id: b.governorateId } }) : null;
        if (!g) throw invalid("Choose a governorate.");
        return { unitKey: `GOVERNORATE:${g.id}`, regionId: g.regionId, governorateId: g.id, centerId: null, villageName: null };
      }
      case "CENTRE": {
        const c = b.centerId ? await this.prisma.center.findUnique({ where: { id: b.centerId }, include: { governorate: true } }) : null;
        if (!c) throw invalid("Choose an administrative centre.");
        return { unitKey: `CENTRE:${c.id}`, regionId: c.governorate.regionId, governorateId: c.governorateId, centerId: c.id, villageName: null };
      }
      case "VILLAGE": {
        // Villages are free text, so a village is named within its governorate.
        const g = b.governorateId ? await this.prisma.governorate.findUnique({ where: { id: b.governorateId } }) : null;
        const name = b.villageName?.trim();
        if (!g || !name) throw invalid("Choose the governorate and enter the village name.");
        return { unitKey: villageUnitKey(g.id, name), regionId: g.regionId, governorateId: g.id, centerId: null, villageName: name };
      }
    }
  }
}
