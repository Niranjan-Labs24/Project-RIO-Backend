import { describe, expect, it } from 'vitest';
import { orgContext } from '../../tenancy/org-context';
import { GeographicDashboardService } from './geographic-dashboard.service';
import type { GeoMapPoint } from './geographic-dashboard.types';

/**
 * The level parameter is the thing worth pinning down: the whole design bet
 * is that moving from governorate to center is a data change, so these tests
 * assert that the same needs land on whichever level has coordinates.
 */

interface SeedNeed {
  id: string;
  status?: string;
  urgency?: string | null;
  sector?: string | null;
  band?: string | null;
  governorateIds?: string[];
  centerIds?: string[];
  initiatives?: number;
  merged?: boolean;
}

const REGION = { id: 'reg-1', name: 'Riyadh', code: 1 };

function fakeTenant(seed: {
  governorates?: Array<{ id: string; code: string; name: string; lat: number | null; lng: number | null }>;
  centers?: Array<{ id: string; code: string; name: string; lat: number | null; lng: number | null }>;
  needs?: SeedNeed[];
}) {
  const governorates = seed.governorates ?? [];
  const centers = seed.centers ?? [];
  const needs = seed.needs ?? [];

  const tx = {
    governorate: {
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const plottable = where?.latitude !== undefined;
        return governorates
          .filter((g) => (plottable ? g.lat !== null : true))
          .map((g) => ({
            id: g.id,
            code: g.code,
            name: g.name,
            latitude: g.lat,
            longitude: g.lng,
            regionId: REGION.id,
            region: REGION,
          }));
      },
      count: async () => governorates.filter((g) => g.lat === null).length,
    },
    center: {
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const plottable = where?.latitude !== undefined;
        return centers
          .filter((c) => (plottable ? c.lat !== null : true))
          .map((c) => ({
            id: c.id,
            code: c.code,
            name: c.name,
            latitude: c.lat,
            longitude: c.lng,
            governorate: { region: { name: REGION.name } },
          }));
      },
      count: async () => centers.filter((c) => c.lat === null).length,
    },
    need: {
      findMany: async () =>
        needs
          .filter((n) => !n.merged)
          .map((n) => ({
            id: n.id,
            status: n.status ?? 'draft',
            urgency: n.urgency ?? null,
            study: { targetSector: n.sector ?? null },
            needGovernorates: (n.governorateIds ?? []).map((governorateId) => ({
              governorateId,
              governorate: { regionId: REGION.id },
            })),
            needCenters: (n.centerIds ?? []).map((centerId) => ({ centerId })),
            priorityScores: n.band ? [{ level: n.band, scoredAt: new Date() }] : [],
            initiativeLinks: Array.from({ length: n.initiatives ?? 0 }, (_, i) => ({
              initiativeId: `init-${i}`,
            })),
          })),
    },
  };

  return {
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
  };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: 'r', orgId: 'org-a', actorId: 'u1', role: 'ngo_admin' }, fn);
}


/** First point, with a readable failure if the map came back empty —
 *  clearer than a non-null assertion when a test regresses. */
function firstPoint(res: { points: GeoMapPoint[] }): GeoMapPoint {
  const p = res.points[0];
  if (!p) throw new Error('expected at least one map point, got none');
  return p;
}

const GOV_A = { id: 'gov-a', code: '0101', name: 'Riyadh', lat: 24.7, lng: 46.7 };
const GOV_B = { id: 'gov-b', code: '0104', name: 'Ad-Dawadmi', lat: 24.5, lng: 44.4 };

describe('GeographicDashboardService.getMap', () => {
  it('aggregates needs onto the governorate that carries them', async () => {
    const svc = new GeographicDashboardService(
      fakeTenant({
        governorates: [GOV_A, GOV_B],
        needs: [
          { id: 'n1', governorateIds: ['gov-a'], band: 'high' },
          { id: 'n2', governorateIds: ['gov-a'], band: 'low' },
          { id: 'n3', governorateIds: ['gov-b'], band: 'low' },
        ],
      }) as never,
    );

    const res = await run(() => svc.getMap('governorate'));
    expect(res.points).toHaveLength(2);
    expect(firstPoint(res)).toMatchObject({ name: 'Riyadh', needCount: 2 });
    expect(res.points[1]).toMatchObject({ name: 'Ad-Dawadmi', needCount: 1 });
  });

  it('colours a place by its WORST band, not its most common one', async () => {
    // One critical need among many low ones must not read as "low" — that is
    // the whole point of the colour.
    const svc = new GeographicDashboardService(
      fakeTenant({
        governorates: [GOV_A],
        needs: [
          { id: 'n1', governorateIds: ['gov-a'], band: 'low' },
          { id: 'n2', governorateIds: ['gov-a'], band: 'low' },
          { id: 'n3', governorateIds: ['gov-a'], band: 'critical' },
        ],
      }) as never,
    );

    const res = await run(() => svc.getMap('governorate'));
    expect(firstPoint(res).priorityBand).toBe('critical');
    expect(firstPoint(res).priorityCounts).toMatchObject({ critical: 1, low: 2 });
  });

  it('reports unscored needs as unscored rather than as low priority', async () => {
    const svc = new GeographicDashboardService(
      fakeTenant({ governorates: [GOV_A], needs: [{ id: 'n1', governorateIds: ['gov-a'] }] }) as never,
    );
    const res = await run(() => svc.getMap('governorate'));
    expect(firstPoint(res).priorityBand).toBeNull();
    expect(firstPoint(res).priorityCounts.unscored).toBe(1);
  });

  it('counts a need once per place when it names two governorates', async () => {
    const svc = new GeographicDashboardService(
      fakeTenant({
        governorates: [GOV_A, GOV_B],
        needs: [{ id: 'n1', governorateIds: ['gov-a', 'gov-b'], band: 'high' }],
      }) as never,
    );
    const res = await run(() => svc.getMap('governorate'));
    expect(res.points.map((p) => p.needCount)).toEqual([1, 1]);
    // ...but it is one need, so coverage must not double-count it.
    expect(res.coverage.needsPlotted).toBe(1);
  });

  it('excludes needs retired by an AI-004 merge', async () => {
    const svc = new GeographicDashboardService(
      fakeTenant({
        governorates: [GOV_A],
        needs: [
          { id: 'n1', governorateIds: ['gov-a'], band: 'high' },
          { id: 'n2', governorateIds: ['gov-a'], band: 'high', merged: true },
        ],
      }) as never,
    );
    const res = await run(() => svc.getMap('governorate'));
    expect(firstPoint(res).needCount).toBe(1);
  });

  it('reports needs that have no location instead of hiding them', async () => {
    const svc = new GeographicDashboardService(
      fakeTenant({
        governorates: [GOV_A],
        needs: [
          { id: 'n1', governorateIds: ['gov-a'] },
          { id: 'n2', governorateIds: [] },
          { id: 'n3', governorateIds: [] },
        ],
      }) as never,
    );
    const res = await run(() => svc.getMap('governorate'));
    expect(res.coverage).toMatchObject({ needsTotal: 3, needsPlotted: 1, needsWithoutLocation: 2 });
  });

  it('never returns a place that has no coordinates', async () => {
    const svc = new GeographicDashboardService(
      fakeTenant({
        governorates: [GOV_A, { id: 'gov-c', code: '0501', name: 'Dammam', lat: null, lng: null }],
        needs: [
          { id: 'n1', governorateIds: ['gov-a'] },
          { id: 'n2', governorateIds: ['gov-c'] },
        ],
      }) as never,
    );
    const res = await run(() => svc.getMap('governorate'));
    expect(res.points.map((p) => p.name)).toEqual(['Riyadh']);
    expect(res.coverage.placesWithoutCoordinates).toBe(1);
    // The Dammam need is not plotted, and says so rather than vanishing.
    expect(res.coverage.needsWithoutLocation).toBe(1);
  });

  describe('filters (AC2)', () => {
    const seeded = () =>
      fakeTenant({
        governorates: [GOV_A, GOV_B],
        needs: [
          { id: 'n1', governorateIds: ['gov-a'], sector: 'Health', urgency: 'high', status: 'draft' },
          { id: 'n2', governorateIds: ['gov-b'], sector: 'Water', urgency: 'low', status: 'reviewer_approved' },
        ],
      }) as never;

    it('filters by sector', async () => {
      const res = await run(() => new GeographicDashboardService(seeded()).getMap('governorate', { sector: 'Health' }));
      expect(res.points.map((p) => p.name)).toEqual(['Riyadh']);
    });

    it('filters by urgency', async () => {
      const res = await run(() => new GeographicDashboardService(seeded()).getMap('governorate', { urgency: 'low' }));
      expect(res.points.map((p) => p.name)).toEqual(['Ad-Dawadmi']);
    });

    it('filters by status', async () => {
      const res = await run(() =>
        new GeographicDashboardService(seeded()).getMap('governorate', { status: 'reviewer_approved' }),
      );
      expect(res.points.map((p) => p.name)).toEqual(['Ad-Dawadmi']);
    });

    it('keeps the filter option lists complete while a filter is applied', async () => {
      // Otherwise choosing one filter empties the other dropdowns and the
      // user cannot get back.
      const res = await run(() => new GeographicDashboardService(seeded()).getMap('governorate', { sector: 'Health' }));
      expect(res.available.sectors).toEqual(['Health', 'Water']);
    });
  });

  describe('level switching', () => {
    it('returns no points at center level while centers have no coordinates', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          governorates: [GOV_A],
          centers: [{ id: 'cen-a', code: '0101-001', name: 'Irqah', lat: null, lng: null }],
          needs: [{ id: 'n1', governorateIds: ['gov-a'], centerIds: ['cen-a'] }],
        }) as never,
      );
      const res = await run(() => svc.getMap('center'));
      expect(res.points).toEqual([]);
      expect(res.coverage.placesWithoutCoordinates).toBe(1);
    });

    it('plots the same needs at center level as soon as coordinates exist', async () => {
      // This is the switch the whole design is built around: only the data
      // changed between this test and the one above.
      const svc = new GeographicDashboardService(
        fakeTenant({
          governorates: [GOV_A],
          centers: [{ id: 'cen-a', code: '0101-001', name: 'Irqah', lat: 24.68, lng: 46.58 }],
          needs: [{ id: 'n1', governorateIds: ['gov-a'], centerIds: ['cen-a'], band: 'high' }],
        }) as never,
      );
      const res = await run(() => svc.getMap('center'));
      expect(res.points).toHaveLength(1);
      expect(firstPoint(res)).toMatchObject({ name: 'Irqah', needCount: 1, priorityBand: 'high' });
    });

    it('rolls governorates up to their region at region level', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          governorates: [GOV_A, GOV_B],
          needs: [
            { id: 'n1', governorateIds: ['gov-a'] },
            { id: 'n2', governorateIds: ['gov-b'] },
          ],
        }) as never,
      );
      const res = await run(() => svc.getMap('region'));
      expect(res.points).toHaveLength(1);
      expect(firstPoint(res)).toMatchObject({ name: 'Riyadh', needCount: 2 });
      // Placed at the mean of its plottable governorates.
      expect(firstPoint(res).latitude).toBeCloseTo((24.7 + 24.5) / 2, 5);
    });
  });

  it('counts linked initiatives per place (AC4)', async () => {
    const svc = new GeographicDashboardService(
      fakeTenant({
        governorates: [GOV_A],
        needs: [
          { id: 'n1', governorateIds: ['gov-a'], initiatives: 2 },
          { id: 'n2', governorateIds: ['gov-a'], initiatives: 1 },
        ],
      }) as never,
    );
    const res = await run(() => svc.getMap('governorate'));
    expect(firstPoint(res).initiativeCount).toBe(3);
  });

  it('reports the most common sector at a place', async () => {
    const svc = new GeographicDashboardService(
      fakeTenant({
        governorates: [GOV_A],
        needs: [
          { id: 'n1', governorateIds: ['gov-a'], sector: 'Water' },
          { id: 'n2', governorateIds: ['gov-a'], sector: 'Water' },
          { id: 'n3', governorateIds: ['gov-a'], sector: 'Health' },
        ],
      }) as never,
    );
    const res = await run(() => svc.getMap('governorate'));
    expect(firstPoint(res).topSector).toBe('Water');
  });
});
