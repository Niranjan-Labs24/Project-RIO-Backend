import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import {
  MAX_INITIATIVES_PER_POINT,
  PRIORITY_BANDS,
  type GeoLevel,
  type GeoMapFilters,
  type GeoMapPoint,
  type GeoMapInitiative,
  type GeoMapOrgSummary,
  type GeoMapResponse,
  type PriorityBand,
} from './geographic-dashboard.types';

/** A need reduced to the fields the map actually aggregates on. */
interface MapNeed {
  id: string;
  status: string;
  urgency: string | null;
  sector: string | null;
  band: PriorityBand | null;
  governorateIds: string[];
  centerIds: string[];
  regionIds: string[];
  initiatives: GeoMapInitiative[];
  studyId: string;
  orgName: string;
  domain: string | null;
  villages: string[];
  isPublished: boolean;
}

/** One plottable place, whatever level it came from. */
interface Place {
  id: string;
  code: string;
  name: string;
  regionName: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  isApproximate: boolean;
}

function emptyCounts(): Record<PriorityBand | 'unscored', number> {
  return { critical: 0, high: 0, medium: 0, low: 0, unscored: 0 };
}

@Injectable()
export class GeographicDashboardService {
  constructor(private readonly tenant: TenantPrismaService) {}

  /**
   * Needs aggregated onto map points at the requested level.
   *
   * Level only changes two things — which places we load, and which id list
   * on a need we group by. Everything after that (filtering, counting,
   * banding, sector highlight) is shared, which is what makes switching from
   * governorate to center a data change rather than a code change.
   */
  async getMap(level: GeoLevel, filters: GeoMapFilters = {}): Promise<GeoMapResponse> {
    const [places, needs, placesWithoutCoordinates] = await Promise.all([
      this.loadPlaces(level),
      this.loadNeeds(),
      this.countPlacesWithoutCoordinates(level),
    ]);

    // Filter option lists come from the unfiltered set, so choosing one
    // filter never empties the other dropdowns.
    const available = {
      sectors: [...new Set(needs.map((n) => n.sector).filter((s): s is string => !!s))].sort(),
      urgencies: [...new Set(needs.map((n) => n.urgency).filter((u): u is string => !!u))].sort(),
      statuses: [...new Set(needs.map((n) => n.status))].sort(),
    };

    const matching = needs.filter(
      (n) =>
        (!filters.sector || n.sector === filters.sector) &&
        (!filters.urgency || n.urgency === filters.urgency) &&
        (!filters.status || n.status === filters.status),
    );

    const placeById = new Map(places.map((p) => [p.id, p]));
    const buckets = new Map<
      string,
      {
        needIds: Set<string>;
        counts: ReturnType<typeof emptyCounts>;
        sectors: Map<string, number>;
        // Keyed by id: two needs at one place often share an initiative, and
        // it must be listed once.
        initiatives: Map<string, GeoMapInitiative>;
        studyIds: Set<string>;
        orgStudies: Map<string, Set<string>>;
        domains: Map<string, number>;
        villages: Set<string>;
        published: number;
      }
    >();

    let plotted = 0;
    for (const need of matching) {
      const ids = this.idsForLevel(need, level);
      // A need with no location at this level cannot be drawn. Counted, not
      // hidden — see `coverage` in the response.
      let placedOnce = false;
      for (const id of ids) {
        if (!placeById.has(id)) continue;
        placedOnce = true;
        let b = buckets.get(id);
        if (!b) {
          b = {
            needIds: new Set(),
            counts: emptyCounts(),
            sectors: new Map(),
            initiatives: new Map(),
            studyIds: new Set(),
            orgStudies: new Map(),
            domains: new Map(),
            villages: new Set(),
            published: 0,
          };
          buckets.set(id, b);
        }
        // A need naming two governorates counts once in each — the map
        // answers "where is there a need", not "how do we divide it up".
        if (!b.needIds.has(need.id)) {
          b.needIds.add(need.id);
          b.counts[need.band ?? 'unscored']++;
          for (const i of need.initiatives) b.initiatives.set(i.id, i);
          b.studyIds.add(need.studyId);
          // Counted per organisation so the NCNP view can say who is active
          // here and how much each is doing.
          const forOrg = b.orgStudies.get(need.orgName) ?? new Set<string>();
          forOrg.add(need.studyId);
          b.orgStudies.set(need.orgName, forOrg);
          if (need.domain) b.domains.set(need.domain, (b.domains.get(need.domain) ?? 0) + 1);
          for (const v of need.villages) b.villages.add(v);
          if (need.isPublished) b.published++;
          if (need.sector) b.sectors.set(need.sector, (b.sectors.get(need.sector) ?? 0) + 1);
        }
      }
      if (placedOnce) plotted++;
    }

    const points: GeoMapPoint[] = [];
    for (const [id, b] of buckets) {
      const place = placeById.get(id)!;
      // Same field as leadingDomain now that "sector" means the need's
      // domain; kept as its own property because the client labels the two
      // differently (a filter chip vs a headline).
      const topSector =
        [...b.sectors.entries()].sort((a, c) => c[1] - a[1])[0]?.[0] ?? null;
      points.push({
        id: place.id,
        code: place.code,
        name: place.name,
        regionName: place.regionName,
        latitude: place.latitude,
        longitude: place.longitude,
        needCount: b.needIds.size,
        // Worst band present wins the colour: a place with one critical need
        // must not read as "low" because nine other needs are low.
        priorityBand: PRIORITY_BANDS.find((band) => b.counts[band] > 0) ?? null,
        priorityCounts: b.counts,
        initiativeCount: b.initiatives.size,
        initiatives: [...b.initiatives.values()]
          .sort((x, y) => x.name.localeCompare(y.name))
          .slice(0, MAX_INITIATIVES_PER_POINT),
        topSector,
        accuracyM: place.accuracyM,
        isApproximate: place.isApproximate,
        studyCount: b.studyIds.size,
        orgCount: b.orgStudies.size,
        publishedCount: b.published,
        leadingDomain:
          [...b.domains.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
        workingOrgs: [...b.orgStudies.entries()]
          .map(([name, studies]): GeoMapOrgSummary => ({ name, studyCount: studies.size }))
          .sort((x, y) => y.studyCount - x.studyCount)
          .slice(0, MAX_INITIATIVES_PER_POINT),
        villages: [...b.villages].sort(),
      });
    }

    points.sort((a, b) => b.needCount - a.needCount);

    return {
      level,
      points,
      coverage: {
        needsTotal: matching.length,
        needsPlotted: plotted,
        needsWithoutLocation: matching.length - plotted,
        placesWithoutCoordinates,
      },
      available,
    };
  }

  private idsForLevel(need: MapNeed, level: GeoLevel): string[] {
    if (level === 'center') return need.centerIds;
    if (level === 'region') return need.regionIds;
    return need.governorateIds;
  }

  private isCrossEntity(): boolean {
    const role = getOrgStore()?.role;
    return role !== undefined && roleByKey(role)?.crossEntity === true;
  }

  /** Geography master is shared reference data, not org-scoped. */
  private async loadPlaces(level: GeoLevel): Promise<Place[]> {
    return this.tenant.runAsSupervisor(async (tx) => {
      if (level === 'region') {
        // Regions carry no coordinates of their own; a region is drawn at
        // the mean of its plottable governorates, which is closer to where
        // its people are than a geometric centre would be.
        const govs = await tx.governorate.findMany({
          where: { latitude: { not: null }, longitude: { not: null } },
          select: { regionId: true, latitude: true, longitude: true, region: { select: { id: true, name: true, code: true } } },
        });
        const byRegion = new Map<string, { sumLat: number; sumLng: number; n: number; name: string; code: string }>();
        for (const g of govs) {
          const r = byRegion.get(g.regionId) ?? {
            sumLat: 0,
            sumLng: 0,
            n: 0,
            name: g.region.name,
            code: String(g.region.code),
          };
          r.sumLat += Number(g.latitude);
          r.sumLng += Number(g.longitude);
          r.n++;
          byRegion.set(g.regionId, r);
        }
        return [...byRegion.entries()].map(([id, r]) => ({
          id,
          code: r.code,
          name: r.name,
          regionName: r.name,
          latitude: r.sumLat / r.n,
          longitude: r.sumLng / r.n,
          // A region is drawn at the mean of its governorates, which is a
          // summary point by construction, not a surveyed one.
          accuracyM: null,
          isApproximate: false,
        }));
      }

      if (level === 'center') {
        const rows = await tx.center.findMany({
          where: { latitude: { not: null }, longitude: { not: null } },
          select: {
            id: true,
            code: true,
            name: true,
            latitude: true,
            longitude: true,
            coordinateAccuracyM: true,
            coordinateSource: true,
            governorate: { select: { region: { select: { name: true } } } },
          },
        });
        return rows.map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          regionName: c.governorate.region.name,
          latitude: Number(c.latitude),
          longitude: Number(c.longitude),
          accuracyM: c.coordinateAccuracyM,
          isApproximate: c.coordinateSource === 'governorate-fallback',
        }));
      }

      const rows = await tx.governorate.findMany({
        where: { latitude: { not: null }, longitude: { not: null } },
        select: {
          id: true,
          code: true,
          name: true,
          latitude: true,
          longitude: true,
          coordinateAccuracyM: true,
          coordinateSource: true,
          region: { select: { name: true } },
        },
      });
      return rows.map((g) => ({
        id: g.id,
        code: g.code,
        name: g.name,
        regionName: g.region.name,
        latitude: Number(g.latitude),
        longitude: Number(g.longitude),
        accuracyM: g.coordinateAccuracyM,
        isApproximate: g.coordinateSource === 'governorate-fallback',
      }));
    });
  }

  private async countPlacesWithoutCoordinates(level: GeoLevel): Promise<number> {
    if (level === 'region') return 0;
    return this.tenant.runAsSupervisor((tx) =>
      level === 'center'
        ? tx.center.count({ where: { latitude: null } })
        : tx.governorate.count({ where: { latitude: null } }),
    );
  }

  /**
   * Every need the caller may see, with just enough joined on to place,
   * filter and colour it.
   */
  private async loadNeeds(): Promise<MapNeed[]> {
    const run = this.isCrossEntity()
      ? this.tenant.runAsSupervisor.bind(this.tenant)
      : this.tenant.runInOrgContext.bind(this.tenant);

    const rows = await run(async (tx) =>
      tx.need.findMany({
        // A retired duplicate must not be counted twice on the map
        // (RIO-AI-004).
        where: { mergedIntoNeedId: null },
        select: {
          id: true,
          status: true,
          urgency: true,
          studyId: true,
          domain: true,
          village: true,
          org: { select: { name: true } },
          study: { select: { targetSector: true } },
          needGovernorates: { select: { governorateId: true, governorate: { select: { regionId: true } } } },
          needCenters: { select: { centerId: true } },
          // Latest score decides the band; earlier ones are history.
          priorityScores: { select: { level: true, scoredAt: true }, orderBy: { scoredAt: 'desc' }, take: 1 },
          needInitiatives: {
            select: {
              initiative: { select: { id: true, name: true, status: true, domain: true } },
            },
          },
        },
      }),
    );

    return rows.map((n) => ({
      id: n.id,
      status: n.status,
      urgency: n.urgency,
      // The need's own domain, not Study.targetSector: a study rarely sets
      // that field, so filtering on it offered one option where the needs
      // themselves carry seven. This is also what `leadingDomain` reports,
      // so the filter and the panel now agree on what "sector" means.
      sector: n.domain ?? null,
      band: (n.priorityScores[0]?.level as PriorityBand | undefined) ?? null,
      governorateIds: n.needGovernorates.map((g) => g.governorateId),
      centerIds: n.needCenters.map((c) => c.centerId),
      regionIds: [...new Set(n.needGovernorates.map((g) => g.governorate.regionId))],
      initiatives: n.needInitiatives.map((x) => x.initiative),
      studyId: n.studyId,
      orgName: n.org.name,
      domain: n.domain,
      villages: n.village,
      // "Published" here means the need cleared human review, which is the
      // sense the old regional panel used.
      isPublished: n.status === 'reviewer_approved',
    }));
  }
}
