import { describe, expect, it } from 'vitest';
import { PriorityV2Service } from './priority-v2.service';

type Level = 'critical' | 'high' | 'medium' | 'low';
const row = (id: string, gapType: string | null, level: Level | null) => ({
  studyId: 's', studyTitle: 'S', needId: id, needTitle: id, gapType, themes: [], urgency: null,
  score: level ? { overallScore: 50, level, overrideReason: null, scoredAt: '2026-01-01', source: 'priorityScore' as const } : null,
});

function service(rows: ReturnType<typeof row>[]) {
  const svc = Object.create(PriorityV2Service.prototype) as PriorityV2Service;
  svc.listForOrg = async () => rows;
  return svc;
}

describe('PriorityV2Service.listPage', () => {
  const rows = [
    row('n1', 'acute', 'high'), row('n2', 'chronic', 'low'), row('n3', 'acute', 'critical'),
    row('n4', null, null), row('n5', 'acute', 'high'),
  ];

  it('slices one page and reports the total', async () => {
    const page = await service(rows).listPage({}, { limit: 2, offset: 2 });
    expect(page.items.map((r) => r.needId)).toEqual(['n3', 'n4']);
    expect(page).toMatchObject({ total: 5, limit: 2, offset: 2 });
  });

  it('filters by gap type and level, and the summary ignores the filters', async () => {
    const page = await service(rows).listPage({ gapType: 'acute', level: 'high' }, { limit: 10, offset: 0 });
    expect(page.items.map((r) => r.needId)).toEqual(['n1', 'n5']);
    expect(page.total).toBe(2);
    expect(page.summary).toEqual({ critical: 1, high: 2, medium: 0, low: 1, unscored: 1 });
  });

  it('rejects an unknown level', async () => {
    await expect(service(rows).listPage({ level: 'urgent' }, { limit: 10, offset: 0 })).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
  });
});
