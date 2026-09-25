import { describe, expect, it, vi } from 'vitest';
import { makeFakeTx } from '../../../test/support/fake-tx';
import { orgContext } from '../../tenancy/org-context';
import { PriorityV2Service } from './priority-v2.service';

function setup() {
  const tx = makeFakeTx();
  const call = async (fn: (t: unknown) => unknown) => fn(tx);
  const tenant = { runInOrgContext: vi.fn(call), runAsSupervisor: vi.fn(call) };
  return { tx, tenant, svc: new PriorityV2Service(tenant as never) };
}
const as = <T>(role: string | undefined, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1', role } as never, fn);
const at = (d: string) => new Date(`${d}T00:00:00Z`);

const configs = [
  {
    domainKey: 'Health',
    domainNameSnapshot: 'Health',
    weight: 0.6,
    isCriticalDomain: true,
    criticalPerformanceThreshold: 30,
  },
  {
    domainKey: 'Education',
    domainNameSnapshot: 'Education',
    weight: 0.4,
    isCriticalDomain: false,
    criticalPerformanceThreshold: 30,
  },
];
const rollup = (entityId: string, severityScore: number | null) => ({
  entityId,
  severityScore,
  villageId: '',
});

function seedCalc(tx: ReturnType<typeof makeFakeTx>) {
  tx.survey.findUnique.mockResolvedValue({ id: 'sv', methodologyVersion: 'v1' });
  tx.methodologyVersion.findFirst.mockResolvedValue({ id: 'mv', version: 'v1' });
  tx.domainPriorityConfig.findMany.mockResolvedValue(configs);
  tx.scoreRollup.findMany.mockResolvedValue([
    rollup('Health', 40),
    rollup('Education', 20),
    rollup('Other', null),
  ]);
}

describe('PriorityV2Service.calculateVillagePriority', () => {
  it('creates an assessment the first time, and updates it afterwards', async () => {
    const { svc, tx } = setup();
    seedCalc(tx);
    expect(await as(undefined, () => svc.calculateVillagePriority('st', 'sv', ''))).toBeNull();
    expect(tx.villagePriorityAssessment.create).toHaveBeenCalledOnce();
    tx.villagePriorityAssessment.findUnique.mockResolvedValue({ id: 'a1' });
    expect(await as(undefined, () => svc.calculateVillagePriority('st', 'sv', 'V1'))).toBeNull();
    expect(tx.villagePriorityAssessment.update).toHaveBeenCalledOnce();
    expect(tx.villagePriorityAssessment.create.mock.calls).toHaveLength(1);
  });

  it('says why nothing was written', async () => {
    const { svc, tx } = setup();
    seedCalc(tx);
    tx.survey.findUnique.mockResolvedValueOnce(null);
    expect(await as(undefined, () => svc.calculateVillagePriority('st', 'sv', ''))).toBe(
      'SURVEY_NOT_FOUND',
    );
    tx.survey.findUnique.mockResolvedValueOnce({ id: 'sv', methodologyVersion: null });
    tx.methodologyVersion.findFirst.mockResolvedValueOnce(null);
    expect(await as(undefined, () => svc.calculateVillagePriority('st', 'sv', ''))).toBe(
      'NO_METHODOLOGY_VERSION',
    );
    expect(tx.methodologyVersion.findFirst.mock.calls[0]![0].where).toEqual({
      status: 'PUBLISHED',
    });
    tx.domainPriorityConfig.findMany.mockResolvedValueOnce([]);
    expect(await as(undefined, () => svc.calculateVillagePriority('st', 'sv', ''))).toBe(
      'NO_DOMAIN_PRIORITY_CONFIG',
    );
    tx.scoreRollup.findMany.mockResolvedValueOnce([]);
    expect(await as(undefined, () => svc.calculateVillagePriority('st', 'sv', ''))).toBe(
      'NO_DOMAIN_ROLLUPS',
    );
  });
});

describe('PriorityV2Service.recalculateAll', () => {
  it('recalculates each village and the consolidated scope, reporting the consolidated outcome', async () => {
    const { svc, tx } = setup();
    seedCalc(tx);
    const spy = vi.spyOn(svc, 'calculateVillagePriority');
    tx.scoreRollup.findMany.mockResolvedValueOnce([
      { villageId: 'V1' },
      { villageId: '' },
      { villageId: 'V2' },
    ]);
    tx.scoreRollup.findMany.mockResolvedValue([rollup('Health', 40)]);
    expect(await as(undefined, () => svc.recalculateAll('st', 'sv'))).toEqual({ success: true });
    expect(spy.mock.calls.map((c) => c[2])).toEqual(['V1', 'V2', '']);
    tx.survey.findUnique.mockResolvedValue(null);
    expect(await as(undefined, () => svc.recalculateAll('st', 'sv'))).toEqual({
      success: false,
      reason: 'SURVEY_NOT_FOUND',
    });
  });
});

describe('PriorityV2Service.listForOrg', () => {
  function seedList(tx: ReturnType<typeof makeFakeTx>) {
    tx.study.findMany.mockResolvedValue([{ id: 's1', title: 'Study' }]);
    const need = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      studyId: 's1',
      title: id,
      gapType: 'acute',
      themes: ['t'],
      urgency: 'high',
      ...over,
    });
    tx.need.findMany.mockResolvedValue([
      need('n-override'),
      need('n-plain'),
      need('n-village'),
      need('n-critical', { gapType: 'chronic', themes: null, urgency: null, studyId: 'other' }),
      need('n-none'),
      need('n-draft'),
    ]);
    const survey = (
      id: string,
      needId: string,
      status = 'PUBLISHED',
      createdAt = at('2026-01-01'),
    ) => ({ id, needId, status, createdAt });
    tx.survey.findMany.mockResolvedValue([
      survey('sv-old', 'n-village', 'DRAFT', at('2026-03-01')),
      survey('sv-pub', 'n-village', 'PUBLISHED', at('2026-01-01')),
      survey('sv-a', 'n-override'),
      survey('sv-b', 'n-plain'),
      survey('sv-c', 'n-critical'),
      survey('sv-d', 'n-none'),
      survey('sv-e', 'n-none', 'PUBLISHED', at('2026-02-01')),
      survey('sv-x', 'n-draft', 'DRAFT'),
    ]);
    tx.villagePriorityAssessment.findMany.mockResolvedValue([
      {
        surveyId: 'sv-pub',
        priorityScore: 41.26,
        overrideApplied: false,
        priorityStatus: 'MEDIUM',
        overrideReason: null,
        calculatedAt: at('2026-02-02'),
      },
      {
        surveyId: 'sv-pub',
        priorityScore: 10,
        overrideApplied: false,
        priorityStatus: 'LOW',
        overrideReason: null,
        calculatedAt: at('2026-01-02'),
      },
      {
        surveyId: 'sv-c',
        priorityScore: 20,
        overrideApplied: true,
        priorityStatus: 'HIGH',
        overrideReason: 'crit',
        calculatedAt: at('2026-02-03'),
      },
    ]);
    tx.priorityScore.findMany.mockResolvedValue([
      {
        needId: 'n-override',
        overrideScore: 90,
        overallScore: 20,
        level: 'low',
        overrideReason: 'why',
        scoredAt: at('2026-02-04'),
      },
      {
        needId: 'n-override',
        overrideScore: null,
        overallScore: 5,
        level: 'low',
        overrideReason: null,
        scoredAt: at('2026-01-04'),
      },
      {
        needId: 'n-plain',
        overrideScore: null,
        overallScore: 55,
        level: 'high',
        overrideReason: null,
        scoredAt: at('2026-02-05'),
      },
    ]);
    tx.methodologyConfig.findFirst.mockResolvedValue({
      priorityThresholds: { criticalSeverity: 80 },
    });
  }

  it('joins each published need to its approved score, or its village rollup, or nothing', async () => {
    const { svc, tx, tenant } = setup();
    seedList(tx);
    const out = await as('ngo_admin', () => svc.listForOrg());
    expect(tenant.runInOrgContext).toHaveBeenCalled();
    const byId = Object.fromEntries(out.map((r) => [r.needId, r]));
    expect(Object.keys(byId).sort()).toEqual([
      'n-critical',
      'n-none',
      'n-override',
      'n-plain',
      'n-village',
    ]);
    expect(byId['n-override']!.score).toMatchObject({
      overallScore: 90,
      source: 'priorityScore',
      overrideReason: 'why',
    });
    expect(byId['n-override']!.score!.level).not.toBe('low');
    expect(byId['n-plain']!.score).toMatchObject({
      overallScore: 55,
      level: 'high',
      source: 'priorityScore',
    });
    expect(byId['n-village']!.score).toMatchObject({
      overallScore: 41.3,
      level: 'medium',
      source: 'villageRollup',
    });
    expect(byId['n-critical']).toMatchObject({ studyTitle: 'other', themes: [], urgency: null });
    expect(byId['n-critical']!.score).toMatchObject({ level: 'critical' });
    expect(byId['n-none']!.score).toBeNull();
  });

  it('filters by gap type, reads across organisations for cross-entity roles, and falls back to default thresholds', async () => {
    const { svc, tx, tenant } = setup();
    seedList(tx);
    tx.methodologyConfig.findFirst.mockResolvedValue(null);
    const out = await as('center_supervisor', () => svc.listForOrg('chronic'));
    expect(out.map((r) => r.needId)).toEqual(['n-critical']);
    expect(tenant.runAsSupervisor).toHaveBeenCalled();
    await as('system_reviewer', () => svc.listForOrg());
    await as('system_admin', () => svc.listForOrg());
    await svc.listForOrg().catch(() => undefined);
  });
});

describe('PriorityV2Service.getVillagePriority', () => {
  it('returns the stored assessment for the survey methodology, or the published one', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValue({ methodologyVersion: 'v1' });
    tx.methodologyVersion.findFirst.mockResolvedValue({ id: 'mv', version: 'v1' });
    tx.villagePriorityAssessment.findUnique.mockResolvedValue({
      priorityScore: '33.5',
      priorityStatus: 'HIGH',
      overrideApplied: false,
      overrideReason: null,
      domainComponents: [],
      calculatedAt: at('2026-01-01'),
      calculationVersion: 'v2',
    });
    expect(await as(undefined, () => svc.getVillagePriority('st', 'sv', 'V1'))).toMatchObject({
      priorityScore: 33.5,
      methodologyVersion: 'v1',
      calculatedAt: at('2026-01-01').toISOString(),
    });
    expect(tx.methodologyVersion.findFirst.mock.calls[0]![0].where).toEqual({ version: 'v1' });
    tx.survey.findUnique.mockResolvedValue(null);
    await as(undefined, () => svc.getVillagePriority('st', 'sv', null));
    expect(tx.methodologyVersion.findFirst.mock.calls[1]![0].where).toEqual({
      status: 'PUBLISHED',
    });
    expect(
      tx.villagePriorityAssessment.findUnique.mock.calls[1]![0].where
        .studyId_surveyId_villageId_methodologyVersionId.villageId,
    ).toBe('');
  });

  it('returns null without a methodology version or an assessment', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValue({ methodologyVersion: 'v1' });
    tx.methodologyVersion.findFirst.mockResolvedValueOnce(null);
    expect(await as(undefined, () => svc.getVillagePriority('st', 'sv', ''))).toBeNull();
    tx.methodologyVersion.findFirst.mockResolvedValueOnce({ id: 'mv', version: 'v1' });
    expect(await as(undefined, () => svc.getVillagePriority('st', 'sv', ''))).toBeNull();
  });
});
