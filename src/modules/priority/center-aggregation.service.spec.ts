import { describe, expect, it } from 'vitest';
import { CenterAggregationService } from './center-aggregation.service';
import { orgContext } from '../../tenancy/org-context';

// Minimal local shapes — only the fields CenterAggregationService actually reads.
interface FakeNeed {
  id: string;
  studyId: string;
  domain: string | null;
  village: string[];
  needCenters: { centerId: string }[];
  needGovernorates: { governorateId: string }[];
  affectedPeople: number | null;
  affectedHouseholds: number | null;
}
interface FakeScore {
  needId: string;
  overallScore: number;
  overrideScore: number | null;
  scoredAt: Date;
}
interface FakeCenter {
  id: string;
  name: string;
  nameAr: string | null;
  governorate: { name: string; nameAr: string | null; region: { name: string; nameAr: string | null } | null };
}
interface FakeGovernorate {
  id: string;
  name: string;
  nameAr: string | null;
  region: { name: string; nameAr: string | null } | null;
}

function fakeTenant(opts: {
  needs?: FakeNeed[];
  scores?: FakeScore[];
  centers?: FakeCenter[];
  governorates?: FakeGovernorate[];
}) {
  const tx = {
    study: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id })) },
    need: {
      findMany: async () => (opts.needs ?? []).map((n) => ({ ...n, affectedPeople: n.affectedPeople, affectedHouseholds: n.affectedHouseholds })),
    },
    priorityScore: { findMany: async () => opts.scores ?? [] },
    center: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        (opts.centers ?? []).filter((c) => where.id.in.includes(c.id)),
    },
    governorate: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        (opts.governorates ?? []).filter((g) => where.id.in.includes(g.id)),
    },
    methodologyConfig: { findFirst: async () => null },
  };
  return {
    runInOrgContext: async (fn: (tx: unknown) => unknown) => fn(tx),
    runRead: async (fn: (tx: unknown) => unknown) => fn(tx),
    runAsSupervisor: async (fn: (tx: unknown) => unknown) => fn(tx),
  };
}

function makeService(tenant: ReturnType<typeof fakeTenant>) {
  return new CenterAggregationService(tenant as never);
}

describe('CenterAggregationService.compareCenters — village-first grouping (client-confirmed 2026-09-24)', () => {
  it('one village linked across several Centres collapses into a single entry, not one per Centre', async () => {
    const svc = makeService(
      fakeTenant({
        needs: [
          { id: 'n1', studyId: 'st1', domain: 'Health', village: ['Irqah'], needCenters: [{ centerId: 'c1' }], needGovernorates: [], affectedPeople: null, affectedHouseholds: null },
          { id: 'n2', studyId: 'st1', domain: 'Health', village: ['Irqah'], needCenters: [{ centerId: 'c2' }], needGovernorates: [], affectedPeople: null, affectedHouseholds: null },
          // Same village, different casing/whitespace — must still collapse.
          { id: 'n3', studyId: 'st1', domain: 'Health', village: [' irqah  '], needCenters: [{ centerId: 'c3' }], needGovernorates: [], affectedPeople: null, affectedHouseholds: null },
        ],
        centers: [
          { id: 'c1', name: 'Abu Jilal', nameAr: null, governorate: { name: 'Ad-Dawadmi', nameAr: null, region: { name: 'Riyadh', nameAr: null } } },
          { id: 'c2', name: 'Abu Rakab', nameAr: null, governorate: { name: 'Ad-Dawadmi', nameAr: null, region: { name: 'Riyadh', nameAr: null } } },
          { id: 'c3', name: 'Ad-Damtha', nameAr: null, governorate: { name: 'Ad-Dawadmi', nameAr: null, region: { name: 'Riyadh', nameAr: null } } },
        ],
      }),
    );

    const entries = await orgContext.run({ requestId: 'r', orgId: 'o1', role: 'ngo_admin' }, () =>
      svc.compareCenters(['st1']),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.villages).toEqual(['Irqah']);
    expect(entries[0]?.totalNeedCount).toBe(3);
    // The Centre caption is the joined, sorted list of every distinct
    // contributing Centre — a reviewer can still see which real places fed
    // this one village card.
    expect(entries[0]?.centerName).toBe('Abu Jilal, Abu Rakab, Ad-Damtha');
    // The frontend needs the individual names (not just the joined display
    // string) to render a non-truncating "first +N more" caption — see
    // village-heat-map.tsx / village-comparison/page.tsx.
    expect(entries[0]?.centerNames).toEqual(['Abu Jilal', 'Abu Rakab', 'Ad-Damtha']);
  });

  it('a Need with no village still groups by Centre (unchanged behavior)', async () => {
    const svc = makeService(
      fakeTenant({
        needs: [
          { id: 'n1', studyId: 'st1', domain: 'Health', village: [], needCenters: [{ centerId: 'c1' }], needGovernorates: [], affectedPeople: null, affectedHouseholds: null },
          { id: 'n2', studyId: 'st1', domain: 'Health', village: [], needCenters: [{ centerId: 'c2' }], needGovernorates: [], affectedPeople: null, affectedHouseholds: null },
        ],
        centers: [
          { id: 'c1', name: 'Abu Jilal', nameAr: null, governorate: { name: 'Ad-Dawadmi', nameAr: null, region: { name: 'Riyadh', nameAr: null } } },
          { id: 'c2', name: 'Abu Rakab', nameAr: null, governorate: { name: 'Ad-Dawadmi', nameAr: null, region: { name: 'Riyadh', nameAr: null } } },
        ],
      }),
    );

    const entries = await orgContext.run({ requestId: 'r', orgId: 'o1', role: 'ngo_admin' }, () =>
      svc.compareCenters(['st1']),
    );

    expect(entries.map((e) => e.centerName).sort()).toEqual(['Abu Jilal', 'Abu Rakab']);
    expect(entries.every((e) => e.villages.length === 0)).toBe(true);
  });

  it('a Need with neither village nor Centre falls back to Governorate', async () => {
    const svc = makeService(
      fakeTenant({
        needs: [
          { id: 'n1', studyId: 'st1', domain: 'Health', village: [], needCenters: [], needGovernorates: [{ governorateId: 'g1' }], affectedPeople: null, affectedHouseholds: null },
        ],
        governorates: [{ id: 'g1', name: 'Ad-Dawadmi', nameAr: null, region: { name: 'Riyadh', nameAr: null } }],
      }),
    );

    const entries = await orgContext.run({ requestId: 'r', orgId: 'o1', role: 'ngo_admin' }, () =>
      svc.compareCenters(['st1']),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.centerName).toBe('Ad-Dawadmi');
    expect(entries[0]?.governorateName).toBe('Ad-Dawadmi');
  });

  it('a Need with both a village and Centres is credited only to the village entry, not also to those Centres', async () => {
    const svc = makeService(
      fakeTenant({
        needs: [
          { id: 'n1', studyId: 'st1', domain: 'Health', village: ['Irqah'], needCenters: [{ centerId: 'c1' }], needGovernorates: [], affectedPeople: null, affectedHouseholds: null },
        ],
        centers: [
          { id: 'c1', name: 'Abu Jilal', nameAr: null, governorate: { name: 'Ad-Dawadmi', nameAr: null, region: { name: 'Riyadh', nameAr: null } } },
        ],
      }),
    );

    const entries = await orgContext.run({ requestId: 'r', orgId: 'o1', role: 'ngo_admin' }, () =>
      svc.compareCenters(['st1']),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.villages).toEqual(['Irqah']);
  });
});
