import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Center, CenterRow, Governorate, GovernorateRow, Region, RegionRow } from './geography.types';

// `regions`/`governorates`/`centers` are global reference tables (no org_id,
// no RLS — same pattern as `domains`/`sub_domains`/`questions`), seeded via
// prisma/import-geography.ts. Read-only here: no create/update/delete —
// this is a fixed external standard (the Regions System), not something the
// app edits (see the model comments in schema.prisma).
@Injectable()
export class GeographyService {
  constructor(private readonly prisma: PrismaService) {}

  async listRegions(): Promise<Region[]> {
    const rows = await this.prisma.region.findMany({ orderBy: { code: 'asc' } });
    return rows.map((r) => this.toRegion(r));
  }

  async listGovernorates(regionId?: string): Promise<Governorate[]> {
    const rows = await this.prisma.governorate.findMany({
      where: regionId ? { regionId } : undefined,
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.toGovernorate(r));
  }

  async listCenters(governorateId?: string): Promise<Center[]> {
    const rows = await this.prisma.center.findMany({
      where: governorateId ? { governorateId } : undefined,
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.toCenter(r));
  }

  // Single-row lookups — used by callers to validate a Region/Governorate/
  // Center id exists (and belongs to the expected parent) without fetching
  // the entire reference table just to find one row.
  async findRegionById(id: string): Promise<Region | null> {
    const row = await this.prisma.region.findUnique({ where: { id } });
    return row ? this.toRegion(row) : null;
  }

  async findGovernorateById(id: string): Promise<Governorate | null> {
    const row = await this.prisma.governorate.findUnique({ where: { id } });
    return row ? this.toGovernorate(row) : null;
  }

  async findCenterById(id: string): Promise<Center | null> {
    const row = await this.prisma.center.findUnique({ where: { id } });
    return row ? this.toCenter(row) : null;
  }

  // Batch lookups — validate a whole regionIds/governorateIds/centerIds set
  // in one query per level instead of one round-trip per id.
  async findRegionsByIds(ids: string[]): Promise<Region[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.region.findMany({ where: { id: { in: ids } } });
    return rows.map((r) => this.toRegion(r));
  }

  async findGovernoratesByIds(ids: string[]): Promise<Governorate[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.governorate.findMany({ where: { id: { in: ids } } });
    return rows.map((r) => this.toGovernorate(r));
  }

  async findCentersByIds(ids: string[]): Promise<Center[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.center.findMany({ where: { id: { in: ids } } });
    return rows.map((r) => this.toCenter(r));
  }

  // One generic hierarchy-check entry point, reused by Organizations
  // (its own full regionId/governorateIds/centerIds sets), Studies (a single
  // governorateId, no centerIds), and Needs (a single governorateId +
  // centerIds) — same validation logic regardless of caller, no
  // Study/Need-flavored duplicate. Checks, in order: every id exists; every
  // Governorate's parent Region equals `regionId` when one is given (skipped
  // if omitted — Study/Need pass their single governorate without needing to
  // know the org's region up front, since NeedsService/StudiesService do
  // that check themselves against the org's own selected ids, a distinct
  // "is this in MY org's scope" concern this function doesn't know about);
  // every Center's parent Governorate is in `governorateIds`.
  async validateHierarchy(input: {
    regionId?: string | null;
    governorateIds: string[];
    centerIds: string[];
  }): Promise<void> {
    const { regionId, governorateIds, centerIds } = input;

    if (regionId) {
      const region = await this.findRegionById(regionId);
      if (!region) {
        throw new BadRequestException({ error: { code: 'REGION_NOT_FOUND', message: 'Region not found' } });
      }
    }

    if (governorateIds.length > 0) {
      const governorates = await this.findGovernoratesByIds(governorateIds);
      if (governorates.length !== new Set(governorateIds).size) {
        throw new BadRequestException({ error: { code: 'GOVERNORATE_NOT_FOUND', message: 'One or more Governorates not found' } });
      }
      if (regionId) {
        const orphan = governorates.find((g) => g.regionId !== regionId);
        if (orphan) {
          throw new BadRequestException({
            error: { code: 'GOVERNORATE_REGION_MISMATCH', message: 'One or more Governorates do not belong to the selected Region.' },
          });
        }
      }
    }

    if (centerIds.length > 0) {
      const centers = await this.findCentersByIds(centerIds);
      if (centers.length !== new Set(centerIds).size) {
        throw new BadRequestException({ error: { code: 'CENTER_NOT_FOUND', message: 'One or more Centers not found' } });
      }
      const governorateIdSet = new Set(governorateIds);
      const orphan = centers.find((c) => !governorateIdSet.has(c.governorateId));
      if (orphan) {
        throw new BadRequestException({
          error: { code: 'CENTER_GOVERNORATE_MISMATCH', message: 'One or more Centers do not belong to a selected Governorate.' },
        });
      }
    }
  }

  private toRegion(row: RegionRow): Region {
    return { id: row.id, code: row.code, name: row.name, isoCode: row.isoCode, capital: row.capital };
  }

  private toGovernorate(row: GovernorateRow): Governorate {
    return { id: row.id, code: row.code, regionId: row.regionId, name: row.name, category: row.category };
  }

  private toCenter(row: CenterRow): Center {
    return { id: row.id, code: row.code, governorateId: row.governorateId, name: row.name, category: row.category };
  }
}
