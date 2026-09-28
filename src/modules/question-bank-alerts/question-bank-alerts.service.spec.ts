import { describe, expect, it } from 'vitest';
import { makeFakeTx } from '../../../test/support/fake-tx';
import { orgContext } from '../../tenancy/org-context';
import { QuestionBankAlertsService } from './question-bank-alerts.service';

function setup() {
  const tx = makeFakeTx();
  const tenant = { runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx) };
  return { tx, svc: new QuestionBankAlertsService(tenant as never) };
}
const as = <T>(role: string | undefined, actorId: string | undefined, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'o', actorId, role } as never, fn);
const q = (over: Record<string, unknown> = {}) => ({
  id: 'q1',
  questionId: 'Q-1',
  questionText: 'T',
  domain: 'D',
  subDomain: 'S',
  previousVersionId: null,
  isActive: true,
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  reviewedAt: new Date('2026-01-02T00:00:00Z'),
  approvalStatus: 'approved',
  rejectionReason: null,
  ...over,
});

describe('QuestionBankAlertsService', () => {
  it('shows reviewers the pending changes and what kind each one is', async () => {
    const { svc, tx } = setup();
    tx.question.findMany.mockResolvedValue([
      q(),
      q({ id: 'q2', previousVersionId: 'p' }),
      q({ id: 'q3', previousVersionId: 'p', isActive: false }),
    ]);
    for (const role of ['human_reviewer', 'system_reviewer']) {
      const out = await as(role, 'u1', () => svc.listAlerts());
      expect(out.map((a) => (a as { changeKind: string }).changeKind)).toEqual([
        'created',
        'edited',
        'deactivated',
      ]);
    }
  });

  it('shows a system admin the outcome of their own recent submissions', async () => {
    const { svc, tx } = setup();
    tx.question.findMany.mockResolvedValue([
      q({ approvalStatus: 'rejected', rejectionReason: 'no' }),
    ]);
    const out = await as('system_admin', 'u1', () => svc.listAlerts());
    expect(out[0]).toMatchObject({
      type: 'question_resolved',
      resolution: 'rejected',
      rejectionReason: 'no',
    });
    expect(tx.question.findMany.mock.calls[0]![0].where.submittedBy).toBe('u1');
  });

  it('shows nothing to other roles, or to a system admin without an actor', async () => {
    const { svc } = setup();
    expect(await as('ngo_admin', 'u1', () => svc.listAlerts())).toEqual([]);
    expect(await as('system_admin', undefined, () => svc.listAlerts())).toEqual([]);
    expect(await as(undefined, undefined, () => svc.listAlerts())).toEqual([]);
    expect(await svc.listAlerts()).toEqual([]);
  });
});
