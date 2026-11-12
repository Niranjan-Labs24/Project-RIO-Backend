import { describe, expect, it, vi } from 'vitest';
import { applyRescoredPairs, DuplicateDetectionService } from './duplicate-detection.service';

const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

describe('applyRescoredPairs (UAT DQ-06 / DQ-10)', () => {
  it('writes the scores by pair id, then dismisses only among those pairs', async () => {
    const executeRaw = vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const pairs = [
      { id: 'p1', score: 0.12 },
      { id: 'p2', score: 0.91 },
    ];
    const dismissed = await applyRescoredPairs(
      { $executeRaw: executeRaw } as never,
      pairs,
      0.7,
      'admin-1',
    );
    expect(dismissed).toBe(1);
    const [write, dismiss] = executeRaw.mock.calls;
    // No `needs` join: under the app role it returned nothing for cross-entity pairs.
    expect(sqlOf(write!)).not.toMatch(/needs/);
    expect(write).toContainEqual(['p1', 'p2']);
    expect(write).toContainEqual([0.12, 0.91]);
    expect(sqlOf(dismiss!)).toMatch(/dc\.id = ANY/);
  });

  it('dismisses nothing when a score did not land', async () => {
    const executeRaw = vi.fn().mockResolvedValueOnce(0);
    await expect(
      applyRescoredPairs(
        { $executeRaw: executeRaw } as never,
        [{ id: 'p1', score: 0.1 }],
        0.7,
        'admin-1',
      ),
    ).rejects.toThrow(/wrote 0 of 1/);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('refreshes scores but dismisses nothing without a person to attribute it to', async () => {
    const executeRaw = vi.fn().mockResolvedValueOnce(1);
    expect(
      await applyRescoredPairs(
        { $executeRaw: executeRaw } as never,
        [{ id: 'p1', score: 0.1 }],
        0.7,
        null,
      ),
    ).toBe(0);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe('DuplicateDetectionService.reconcileCrossOrgLiteral', () => {
  it('scores cross-entity pairs with the supervisor client and writes them back by id', async () => {
    // A pair matched only on a placeholder reference: stored at 1, its text says 0.2.
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'x1', score: 0.2 }]);
    const executeRaw = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    const tenant = {
      runAsSupervisor: async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: queryRaw }),
      runAsSupervisorWrite: async (fn: (tx: unknown) => unknown) => fn({ $executeRaw: executeRaw }),
    };
    const svc = new DuplicateDetectionService(tenant as never, {} as never);
    await expect(svc.reconcileCrossOrgLiteral(0.7, 'admin-1')).resolves.toBe(1);
    expect(sqlOf(queryRaw.mock.calls[0]!)).toMatch(/dc\.scope = 'cross_org'/);
    expect(executeRaw.mock.calls[0]).toContainEqual(['x1']);
    expect(executeRaw.mock.calls[0]).toContainEqual([0.2]);
  });
});
