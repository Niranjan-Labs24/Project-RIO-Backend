import { describe, expect, it, vi } from 'vitest';
import { orgContext, type OrgStore } from '../../tenancy/org-context';
import { CenterAggregationService } from './center-aggregation.service';

const run = <T>(store: Partial<OrgStore>, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1', ...store } as OrgStore, fn);

const need = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  studyId: 's1',
  domain: 'Water',
  village: [],
  gapType: 'acute',
  ...over,
});

function setup() {
  const tx = {
    need: { findMany: vi.fn().mockResolvedValue([need()]) },
    priorityScore: { findMany: vi.fn().mockResolvedValue([]) },
    survey: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: 'sv1', needId: 'n1', methodologyVersion: 'v5.0' }]),
    },
    methodologyConfig: { findFirst: vi.fn().mockResolvedValue(null) },
    gapTypeOption: { findMany: vi.fn().mockResolvedValue([{ name: 'acute', nameAr: 'حاد' }]) },
    methodologyVersion: { findFirst: vi.fn().mockResolvedValue({ id: 'mv1' }) },
    scoreRollup: {
      findMany: vi.fn().mockResolvedValue([
        {
          entityId: 'Q1',
          entityNameSnapshot: 'KPI one',
          severityScore: 80,
          confidenceLevel: 'LOW',
        },
        {
          entityId: 'Q2',
          entityNameSnapshot: 'KPI two',
          severityScore: null,
          confidenceLevel: 'STANDARD',
        },
        {
          entityId: 'Q3',
          entityNameSnapshot: 'KPI three',
          severityScore: 20,
          confidenceLevel: 'STANDARD',
        },
      ]),
    },
    question: {
      findMany: vi.fn().mockResolvedValue([
        {
          questionId: 'Q1',
          analyticalCategory: 'Access',
          kpi: 'Distance to clinic',
          kpiAr: 'المسافة',
        },
        { questionId: 'Q3', analyticalCategory: null, kpi: null, kpiAr: null },
      ]),
    },
  };
  const tenant = {
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  return { tx, svc: new CenterAggregationService(tenant as never) };
}

describe('CenterAggregationService.kpiBreakdownForDomain', () => {
  it('requires at least one study', async () => {
    const { svc } = setup();
    await expect(
      run({ role: 'ngo_admin' }, () => svc.kpiBreakdownForDomain('c1', 'Water', [])),
    ).rejects.toMatchObject({
      response: { error: { code: 'NO_STUDIES_SELECTED' } },
    });
  });

  it('breaks a centre and domain down by KPI, highest severity first, with tiers and gap types', async () => {
    const { svc, tx } = setup();
    tx.priorityScore.findMany.mockResolvedValue([
      { needId: 'n1', equityFlagged: true, gapType: 'chronic', cycleNote: 'Chronic — cycle 2' },
      { needId: 'n1', equityFlagged: false, gapType: 'old', cycleNote: null },
    ]);
    const result = await run({ role: 'ngo_admin' }, () =>
      svc.kpiBreakdownForDomain('center-1', 'Water', ['s1']),
    );
    expect(result.map((r) => r.kpi)).toEqual(['Distance to clinic', 'KPI three', 'KPI two']);
    expect(result[0]).toMatchObject({
      kpiAr: 'المسافة',
      severityScore: 80,
      analyticalCategory: 'Access',
      gapType: 'chronic',
      gapTypeAr: null,
      equityFlag: true,
      confidence: 'low',
      additionalGapTypeLabel: 'Chronic — cycle 2',
    });
    expect(result[0]!.priorityTier).toBeTruthy();
    expect(result[1]).toMatchObject({
      kpi: 'KPI three',
      kpiAr: null,
      analyticalCategory: null,
      confidence: 'standard',
      equityFlag: true,
    });
    expect(result[2]).toMatchObject({ severityScore: null, priorityTier: null });
    expect(tx.need.findMany.mock.calls[0]![0].where.needCenters).toEqual({
      some: { centerId: 'center-1' },
    });
  });

  it("falls back to the need's own gap type and its Arabic name when there is no score", async () => {
    const { svc } = setup();
    const result = await run({ role: 'ngo_admin' }, () =>
      svc.kpiBreakdownForDomain('center-1', 'Water', ['s1']),
    );
    expect(result[0]).toMatchObject({
      gapType: 'acute',
      gapTypeAr: 'حاد',
      additionalGapTypeLabel: null,
    });
  });

  it('uses configured thresholds, and reads a gapless need as having no gap type', async () => {
    const { svc, tx } = setup();
    tx.methodologyConfig.findFirst.mockResolvedValue({
      priorityThresholds: { criticalSeverity: 10 },
    });
    tx.need.findMany.mockResolvedValue([need({ gapType: null })]);
    const result = await run({ role: 'ngo_admin' }, () =>
      svc.kpiBreakdownForDomain('center-1', 'Water', ['s1']),
    );
    expect(result[0]).toMatchObject({ priorityTier: 'critical', gapType: null, gapTypeAr: null });
  });

  it('matches village-keyed places by their normalised name', async () => {
    const { svc, tx } = setup();
    tx.need.findMany.mockResolvedValue([
      need({ village: ['Al  Nakheel'] }),
      need({ id: 'n2', village: ['Elsewhere', ''] }),
    ]);
    const result = await run({ role: 'ngo_admin' }, () =>
      svc.kpiBreakdownForDomain('village:al nakheel', 'Water', ['s1']),
    );
    expect(result.length).toBeGreaterThan(0);
    expect(tx.need.findMany.mock.calls[0]![0].where.village).toEqual({ isEmpty: false });
  });

  it('matches governorate-keyed places for needs recorded only at governorate level', async () => {
    const { svc, tx } = setup();
    await run({ role: 'ngo_admin' }, () =>
      svc.kpiBreakdownForDomain('governorate:g-9', 'Water', ['s1']),
    );
    expect(tx.need.findMany.mock.calls[0]![0].where.needGovernorates).toEqual({
      some: { governorateId: 'g-9' },
    });
  });

  it('returns nothing when no need matches', async () => {
    const { svc, tx } = setup();
    tx.need.findMany.mockResolvedValue([]);
    expect(
      await run({ role: 'ngo_admin' }, () => svc.kpiBreakdownForDomain('c', 'Water', ['s1'])),
    ).toEqual([]);
  });

  it('skips needs with no published survey, no methodology version, or no KPI rollups', async () => {
    const { svc, tx } = setup();
    tx.need.findMany.mockResolvedValue([
      need(),
      need({ id: 'n2' }),
      need({ id: 'n3' }),
      need({ id: 'n4' }),
    ]);
    tx.survey.findMany.mockResolvedValue([
      { id: 'sv1', needId: 'n1', methodologyVersion: null },
      { id: 'sv2', needId: 'n2', methodologyVersion: 'v9' },
      { id: 'sv3', needId: 'n3', methodologyVersion: 'v5.0' },
    ]);
    tx.methodologyVersion.findFirst
      .mockResolvedValueOnce({ id: 'mv1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'mv2' });
    tx.scoreRollup.findMany
      .mockResolvedValueOnce([
        { entityId: 'Q1', entityNameSnapshot: 'K', severityScore: 5, confidenceLevel: 'STANDARD' },
      ])
      .mockResolvedValueOnce([]);
    const result = await run({ role: 'ngo_admin' }, () =>
      svc.kpiBreakdownForDomain('c', 'Water', ['s1']),
    );
    expect(result).toHaveLength(1);
  });

  it('reads across organizations for a cross-entity role', async () => {
    const { svc } = setup();
    expect(
      (
        await run({ role: 'center_supervisor' }, () =>
          svc.kpiBreakdownForDomain('c', 'Water', ['s1']),
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (await run({}, () => svc.kpiBreakdownForDomain('c', 'Water', ['s1']))).length,
    ).toBeGreaterThan(0);
  });
});
