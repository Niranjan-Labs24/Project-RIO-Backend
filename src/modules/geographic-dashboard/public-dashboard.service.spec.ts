import { describe, expect, it } from 'vitest';
import { PublicDashboardService } from './public-dashboard.service';

/**
 * The service trusts the database to apply the "which needs count" filter, so
 * these tests pin two things: that the filter asked for is the right one, and
 * that the averages built from whatever comes back are right.
 */

const GOV = {
  shaqra: { code: '0110', name: 'Shaqra', nameAr: 'شقراء', regionId: 'r1' },
  thadiq: { code: '0117', name: 'Thadiq', nameAr: 'ثادق', regionId: 'r1' },
  sabya: { code: '1002', name: 'Sabya', nameAr: 'صبيا', regionId: 'r10' },
};

type Row = {
  id: string;
  domain: string | null;
  score: number | null;
  override?: number | null;
  govs: (typeof GOV)[keyof typeof GOV][];
};

function service(rows: Row[]) {
  const calls: { needWhere?: unknown } = {};
  const tx = {
    domain: {
      findMany: async () => [
        { code: 'W', name: 'Water & Sanitation', nameAr: 'المياه والصرف الصحي' },
        { code: 'E', name: 'Education', nameAr: 'التعليم' },
        { code: 'H', name: 'Health', nameAr: 'الصحة' },
      ],
    },
    need: {
      findMany: async ({ where }: { where: unknown }) => {
        calls.needWhere = where;
        return rows.map((r) => ({
          id: r.id,
          domain: r.domain,
          priorityScores:
            r.score === null ? [] : [{ overallScore: r.score, overrideScore: r.override ?? null }],
          needGovernorates: r.govs.map((governorate) => ({ governorate })),
        }));
      },
    },
    region: {
      findMany: async () => [
        { id: 'r1', code: 1, name: 'Riyadh', nameAr: 'الرياض' },
        { id: 'r10', code: 10, name: 'Jazan', nameAr: 'جازان' },
      ],
    },
  };
  const tenant = {
    runAsSupervisor: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
  return { svc: new PublicDashboardService(tenant as never), calls };
}

describe('PublicDashboardService', () => {
  it('counts only approved, unmerged, scored, placed needs from live (not imported) studies', async () => {
    const { svc, calls } = service([]);
    await svc.get();
    expect(calls.needWhere).toEqual({
      status: 'reviewer_approved',
      mergedIntoNeedId: null,
      study: { isHistorical: false },
      priorityScores: { some: {} },
      needGovernorates: { some: {} },
    });
  });

  it('averages per governorate and per domain, using the reviewer override when set', async () => {
    const { svc } = service([
      { id: 'n1', domain: 'Education', score: 80, govs: [GOV.shaqra] },
      { id: 'n2', domain: 'education ', score: 60, govs: [GOV.shaqra] },
      { id: 'n3', domain: 'الصحة', score: 10, override: 40, govs: [GOV.shaqra] },
    ]);
    const res = await svc.get();
    const shaqra = res.governorates.find((g) => g.code === '0110')!;
    expect(shaqra).toMatchObject({ regionCode: 1, needCount: 3, score: 60 });
    expect(shaqra.domains).toEqual([
      { code: 'E', score: 70, needCount: 2 },
      { code: 'H', score: 40, needCount: 1 },
    ]);
  });

  it('counts a need once per region even when it spans two of its governorates', async () => {
    const { svc } = service([
      { id: 'n1', domain: 'Health', score: 90, govs: [GOV.shaqra, GOV.thadiq] },
      { id: 'n2', domain: 'Health', score: 30, govs: [GOV.thadiq] },
    ]);
    const res = await svc.get();
    expect(res.regions).toEqual([
      expect.objectContaining({ regionCode: 1, needCount: 2, score: 60 }),
    ]);
    expect(res.governorates.map((g) => [g.code, g.needCount, g.score])).toEqual([
      ['0110', 1, 90],
      ['0117', 2, 60],
    ]);
    expect(res.totals).toEqual({ needs: 2, regions: 1, governorates: 2 });
  });

  it('keeps an unmatched domain in the place total but out of the domain rows', async () => {
    const { svc } = service([{ id: 'n1', domain: 'Retired domain', score: 50, govs: [GOV.sabya] }]);
    const res = await svc.get();
    expect(res.governorates[0]).toMatchObject({ needCount: 1, score: 50, domains: [] });
  });

  it('returns totals only — no need text, organisation or study', async () => {
    const { svc } = service([{ id: 'n1', domain: 'Health', score: 50, govs: [GOV.sabya] }]);
    const json = JSON.stringify(await svc.get());
    expect(json).not.toContain('n1');
    expect(json).not.toMatch(/org|study|title|statement|village/i);
  });
});
