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
  /** The need's domain. "Sector" on this map means the need's own domain,
   *  not Study.targetSector — a study rarely sets that, so filtering on it
   *  offered a single option. */
  sector?: string | null;
  band?: string | null;
  governorateIds?: string[];
  centerIds?: string[];
  /** Initiative names linked to this need. Named rather than counted so a
   *  test can assert de-duplication across needs at the same place. */
  initiatives?: string[];
  /** Which study this need belongs to — drives the per-place study count. */
  studyId?: string;
  /** Owning organisation's name — the NCNP view lists these. */
  orgName?: string;
  domain?: string | null;
  villages?: string[];
  merged?: boolean;
}

const REGION = { id: 'reg-1', name: 'Riyadh', code: 1 };

function fakeTenant(seed: {
  governorates?: Array<{ id: string; code: string; name: string; lat: number | null; lng: number | null; accuracyM?: number | null; source?: string | null }>;
  centers?: Array<{ id: string; code: string; name: string; lat: number | null; lng: number | null; accuracyM?: number | null; source?: string | null }>;
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
            coordinateAccuracyM: g.accuracyM ?? null,
            coordinateSource: g.source ?? null,
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
            coordinateAccuracyM: c.accuracyM ?? null,
            coordinateSource: c.source ?? null,
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
            studyId: n.studyId ?? 'study-1',
            domain: n.domain ?? n.sector ?? null,
            village: n.villages ?? [],
            org: { name: n.orgName ?? 'Demo NGO' },
            study: { targetSector: null },
            needGovernorates: (n.governorateIds ?? []).map((governorateId) => ({
              governorateId,
              governorate: { regionId: REGION.id },
            })),
            needCenters: (n.centerIds ?? []).map((centerId) => ({ centerId })),
            priorityScores: n.band ? [{ level: n.band, scoredAt: new Date() }] : [],
            needInitiatives: (n.initiatives ?? []).map((name) => ({
              initiative: { id: `init-${name}`, name, status: 'active', domain: null },
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

  describe('linked initiatives (AC4)', () => {
    it('lists the initiatives at a place, not just how many', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          governorates: [GOV_A],
          needs: [
            { id: 'n1', governorateIds: ['gov-a'], initiatives: ['Water Access'] },
            { id: 'n2', governorateIds: ['gov-a'], initiatives: ['Clinic Staffing'] },
          ],
        }) as never,
      );
      const res = await run(() => svc.getMap('governorate'));
      expect(firstPoint(res).initiativeCount).toBe(2);
      expect(firstPoint(res).initiatives.map((i) => i.name)).toEqual([
        'Clinic Staffing',
        'Water Access',
      ]);
    });

    it('counts an initiative once when two needs at the same place share it', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          governorates: [GOV_A],
          needs: [
            { id: 'n1', governorateIds: ['gov-a'], initiatives: ['Water Access'] },
            { id: 'n2', governorateIds: ['gov-a'], initiatives: ['Water Access'] },
          ],
        }) as never,
      );
      const res = await run(() => svc.getMap('governorate'));
      expect(firstPoint(res).initiativeCount).toBe(1);
      expect(firstPoint(res).initiatives).toHaveLength(1);
    });

    it('gives each initiative the fields the client needs to link to it', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          governorates: [GOV_A],
          needs: [{ id: 'n1', governorateIds: ['gov-a'], initiatives: ['Water Access'] }],
        }) as never,
      );
      const res = await run(() => svc.getMap('governorate'));
      expect(firstPoint(res).initiatives[0]).toMatchObject({
        id: expect.any(String),
        name: 'Water Access',
        status: 'active',
      });
    });

    it('reports no initiatives as an empty list rather than undefined', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({ governorates: [GOV_A], needs: [{ id: 'n1', governorateIds: ['gov-a'] }] }) as never,
      );
      const res = await run(() => svc.getMap('governorate'));
      expect(firstPoint(res).initiativeCount).toBe(0);
      expect(firstPoint(res).initiatives).toEqual([]);
    });
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

  describe('coordinate accuracy', () => {
    // 365 of our 1,404 centers sit at their governorate's centre rather than
    // their own location, some over 100km out. If the map cannot tell those
    // apart, somebody funds the wrong village.
    it('marks a governorate-fallback point as approximate and reports its accuracy', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          centers: [
            { id: 'cen-a', code: '0101-001', name: 'Estimated', lat: 24.7, lng: 46.7, accuracyM: 87000, source: 'governorate-fallback' },
          ],
          needs: [{ id: 'n1', centerIds: ['cen-a'] }],
        }) as never,
      );
      const res = await run(() => svc.getMap('center'));
      expect(firstPoint(res).isApproximate).toBe(true);
      expect(firstPoint(res).accuracyM).toBe(87000);
    });

    it('does not mark a geocoded point as approximate', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          centers: [
            { id: 'cen-a', code: '0101-001', name: 'Surveyed', lat: 24.68, lng: 46.58, accuracyM: 2000, source: 'nominatim' },
          ],
          needs: [{ id: 'n1', centerIds: ['cen-a'] }],
        }) as never,
      );
      const res = await run(() => svc.getMap('center'));
      expect(firstPoint(res).isApproximate).toBe(false);
      expect(firstPoint(res).accuracyM).toBe(2000);
    });

    it('treats an overpass rescue as exact, same as a nominatim hit', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          centers: [
            { id: 'cen-a', code: '0101-001', name: 'Rescued', lat: 24.68, lng: 46.58, accuracyM: 2000, source: 'overpass' },
          ],
          needs: [{ id: 'n1', centerIds: ['cen-a'] }],
        }) as never,
      );
      const res = await run(() => svc.getMap('center'));
      expect(firstPoint(res).isApproximate).toBe(false);
    });

    it('carries accuracy at governorate level too', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          governorates: [{ ...GOV_A, accuracyM: 45000, source: 'governorate-fallback' }],
          needs: [{ id: 'n1', governorateIds: ['gov-a'] }],
        }) as never,
      );
      const res = await run(() => svc.getMap('governorate'));
      expect(firstPoint(res)).toMatchObject({ isApproximate: true, accuracyM: 45000 });
    });
  });


  describe('study and organisation view (merged into the same response)', () => {
    // These used to come from a separate component that fetched studies and
    // then one request per study. Folding them in means one call answers
    // both of the dashboard's questions.
    it('counts distinct studies at a place, not needs', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          governorates: [GOV_A],
          needs: [
            { id: 'n1', governorateIds: ['gov-a'], studyId: 's1' },
            { id: 'n2', governorateIds: ['gov-a'], studyId: 's1' },
            { id: 'n3', governorateIds: ['gov-a'], studyId: 's2' },
          ],
        }) as never,
      );
      const res = await run(() => svc.getMap('governorate'));
      expect(firstPoint(res).needCount).toBe(3);
      expect(firstPoint(res).studyCount).toBe(2);
    });

    it('lists the organisations working at a place, biggest first', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          governorates: [GOV_A],
          needs: [
            { id: 'n1', governorateIds: ['gov-a'], orgName: 'Alpha NGO', studyId: 's1' },
            { id: 'n2', governorateIds: ['gov-a'], orgName: 'Alpha NGO', studyId: 's2' },
            { id: 'n3', governorateIds: ['gov-a'], orgName: 'Beta NGO', studyId: 's3' },
          ],
        }) as never,
      );
      const res = await run(() => svc.getMap('governorate'));
      expect(firstPoint(res).orgCount).toBe(2);
      expect(firstPoint(res).workingOrgs).toEqual([
        { name: 'Alpha NGO', studyCount: 2 },
        { name: 'Beta NGO', studyCount: 1 },
      ]);
    });

    it('counts only reviewer-approved needs as published', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          governorates: [GOV_A],
          needs: [
            { id: 'n1', governorateIds: ['gov-a'], status: 'reviewer_approved' },
            { id: 'n2', governorateIds: ['gov-a'], status: 'draft' },
            { id: 'n3', governorateIds: ['gov-a'], status: 'ai_classified' },
          ],
        }) as never,
      );
      const res = await run(() => svc.getMap('governorate'));
      expect(firstPoint(res).publishedCount).toBe(1);
    });

    it('reports the most common domain at a place', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          governorates: [GOV_A],
          needs: [
            { id: 'n1', governorateIds: ['gov-a'], domain: 'Health' },
            { id: 'n2', governorateIds: ['gov-a'], domain: 'Health' },
            { id: 'n3', governorateIds: ['gov-a'], domain: 'Education' },
          ],
        }) as never,
      );
      const res = await run(() => svc.getMap('governorate'));
      expect(firstPoint(res).leadingDomain).toBe('Health');
    });

    it('collects village names once each, sorted', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({
          governorates: [GOV_A],
          needs: [
            { id: 'n1', governorateIds: ['gov-a'], villages: ['Shaqra', 'Thadiq'] },
            { id: 'n2', governorateIds: ['gov-a'], villages: ['Shaqra'] },
          ],
        }) as never,
      );
      const res = await run(() => svc.getMap('governorate'));
      expect(firstPoint(res).villages).toEqual(['Shaqra', 'Thadiq']);
    });

    it('leaves leadingDomain null when nothing is classified yet', async () => {
      const svc = new GeographicDashboardService(
        fakeTenant({ governorates: [GOV_A], needs: [{ id: 'n1', governorateIds: ['gov-a'] }] }) as never,
      );
      const res = await run(() => svc.getMap('governorate'));
      expect(firstPoint(res).leadingDomain).toBeNull();
      expect(firstPoint(res).villages).toEqual([]);
    });
  });

});
