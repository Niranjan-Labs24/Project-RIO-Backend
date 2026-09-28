import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../tenancy/org-context';

const ai = vi.hoisted(() => ({ classify: vi.fn() }));
vi.mock('./classification.ai', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  classifyNeedWithAi: ai.classify,
}));

import { AiClassificationDeclinedError } from './classification.ai';
import { AiDecisionsService } from './ai-decisions.service';

const asActor = <T>(fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1' }, fn);

const need = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  studyId: 's1',
  title: 'Wells',
  statement: 'No water in the village',
  village: ['A', 'B'],
  status: 'pending_ai_classification',
  ...over,
});
const domains = [
  {
    code: 'W',
    name: 'Water',
    isActive: true,
    subDomains: [
      { code: 'WS', name: 'Supply', isActive: true },
      { code: 'WX', name: 'Retired', isActive: false },
    ],
  },
  { code: 'H', name: 'Health', isActive: false, subDomains: [] },
];
const result = (over: Record<string, unknown> = {}) => ({
  modelName: 'm',
  modelVersion: '1',
  confidence: 0.9,
  suggestion: {
    domains: ['Water'],
    subDomains: ['Supply'],
    rationale: 'r',
    redactedStatement: 'x',
    village: 'A',
  },
  ...over,
});

function setup() {
  const tx = {
    need: { findUnique: vi.fn().mockResolvedValue(need()), update: vi.fn() },
    aiDecision: {
      create: vi
        .fn()
        .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'd1',
          createdAt: new Date('2026-03-01T00:00:00Z'),
          humanDecision: null,
          decidedBy: null,
          decidedAt: null,
          studyId: 's1',
          touchpoint: 'need_classification',
          subjectType: 'need',
          subjectId: 'n1',
          ...data,
        })),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const tenant = { runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const domainsSvc = { listDomainsWithSubDomains: vi.fn().mockResolvedValue(domains) };
  const surveys = { generateSuggestedQuestions: vi.fn().mockResolvedValue(undefined) };
  const methodologyConfig = {
    getRaw: vi
      .fn()
      .mockResolvedValue({
        aiClassificationSettings: { lowConfidenceThreshold: 0.6, veryLowConfidenceThreshold: 0.3 },
      }),
  };
  const svc = new AiDecisionsService(
    tenant as never,
    audit as never,
    {} as never,
    domainsSvc as never,
    surveys as never,
    methodologyConfig as never,
    {} as never,
  );
  return { tx, audit, domainsSvc, surveys, svc };
}

describe('AiDecisionsService classification', () => {
  it('classifies a need, stores the decision with its confidence band and asks for suggested questions', async () => {
    const { svc, tx, audit, surveys } = setup();
    ai.classify.mockResolvedValue(result());
    const decision = await asActor(() => svc.classifyAutomatically('n1'));
    expect(decision).toMatchObject({
      confidence: 0.9,
      confidenceBand: 'standard',
      confidenceThresholds: { low: 0.6, veryLow: 0.3 },
    });
    expect(tx.need.update.mock.calls[0]![0].data).toMatchObject({
      status: 'ai_classified',
      allDomainsSelected: false,
      aiSuggestedDomain: 'Water',
      aiSuggestedSubDomain: 'Supply',
    });
    expect(audit.record.mock.calls[0]![0].changes[0].after).toBe('Water / Supply');
    expect(surveys.generateSuggestedQuestions).toHaveBeenCalledWith('n1', [
      { domain: 'Water', subDomain: 'Supply' },
    ]);
  });

  it('selects every domain when the AI declines, and records a zero confidence', async () => {
    const { svc, tx, audit, surveys } = setup();
    ai.classify.mockRejectedValue(new AiClassificationDeclinedError('too vague'));
    const decision = await asActor(() => svc.classifyAutomatically('n1'));
    expect(decision).toMatchObject({
      confidence: 0,
      confidenceBand: 'very_low',
      modelName: 'unclear-all-domains',
    });
    expect(tx.need.update.mock.calls[0]![0].data).toMatchObject({
      allDomainsSelected: true,
      aiSuggestedDomain: null,
    });
    expect(audit.record.mock.calls[0]![0].changes[0].after).toBeNull();
    expect(surveys.generateSuggestedQuestions).toHaveBeenCalledWith('n1', []);
  });

  it('marks the need as failed when the AI errors, and rethrows', async () => {
    const { svc, tx } = setup();
    ai.classify.mockRejectedValue(new Error(''));
    await expect(asActor(() => svc.classifyAutomatically('n1'))).rejects.toThrow();
    expect(tx.need.update.mock.calls[0]![0].data).toMatchObject({
      status: 'ai_classification_failed',
      classificationError: 'AI classification failed.',
    });
  });

  it('treats an unrecognised classification as a decline, and no active domains as a failure', async () => {
    const { svc, domainsSvc } = setup();
    ai.classify.mockResolvedValue(
      result({
        suggestion: {
          domains: ['Water'],
          subDomains: ['Nope'],
          rationale: 'r',
          redactedStatement: '',
          village: '',
        },
      }),
    );
    expect((await asActor(() => svc.classifyAutomatically('n1'))).modelName).toBe(
      'unclear-all-domains',
    );
    ai.classify.mockResolvedValue(
      result({
        suggestion: {
          domains: [],
          subDomains: [],
          rationale: 'r',
          redactedStatement: '',
          village: '',
        },
      }),
    );
    expect((await asActor(() => svc.classifyAutomatically('n1'))).modelName).toBe(
      'unclear-all-domains',
    );
    domainsSvc.listDomainsWithSubDomains.mockResolvedValue([]);
    await expect(asActor(() => svc.classifyAutomatically('n1'))).rejects.toThrow(
      'No active domains configured',
    );
  });

  it('continues when suggested-question generation fails', async () => {
    const { svc, surveys } = setup();
    ai.classify.mockResolvedValue(result());
    surveys.generateSuggestedQuestions.mockRejectedValue(new Error('gen'));
    await expect(asActor(() => svc.classifyAutomatically('n1'))).resolves.toBeTruthy();
  });

  it('refuses an unknown need and one already moved on in its workflow', async () => {
    const { svc, tx } = setup();
    tx.need.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.classifyAutomatically('x'))).rejects.toMatchObject({
      response: { error: { code: 'NEED_NOT_FOUND' } },
    });
    tx.need.findUnique.mockResolvedValueOnce(need({ status: 'reviewer_approved' }));
    await expect(asActor(() => svc.classifyAutomatically('n1'))).rejects.toMatchObject({
      response: { error: { code: 'NEED_ALREADY_CLASSIFIED' } },
    });
  });
});

describe('AiDecisionsService retry and manual classification', () => {
  it('resets a failed need and classifies it again', async () => {
    const { svc, tx } = setup();
    tx.need.findUnique.mockResolvedValue(need({ status: 'ai_classification_failed' }));
    ai.classify.mockResolvedValue(result());
    await asActor(() => svc.retryClassification('n1'));
    expect(tx.need.update.mock.calls[0]![0].data).toMatchObject({
      status: 'pending_ai_classification',
      classificationError: null,
    });
  });

  it('refuses a retry for an unknown need or one that has not failed', async () => {
    const { svc, tx } = setup();
    tx.need.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.retryClassification('x'))).rejects.toMatchObject({
      response: { error: { code: 'NEED_NOT_FOUND' } },
    });
    tx.need.findUnique.mockResolvedValueOnce(need({ status: 'ai_classified' }));
    await expect(asActor(() => svc.retryClassification('n1'))).rejects.toMatchObject({
      response: { error: { code: 'NEED_NOT_FAILED' } },
    });
  });

  it('classifies by hand a need whose automatic classification failed, and audits it', async () => {
    const { svc, tx, audit, surveys } = setup();
    tx.need.findUnique.mockResolvedValue(need({ status: 'ai_classification_failed' }));
    await asActor(() =>
      svc.manualClassify('n1', { pairs: [{ domain: 'Water', subDomain: 'Supply' }] } as never),
    );
    expect(tx.need.update.mock.calls[0]![0].data).toMatchObject({
      domain: 'Water',
      subDomain: 'Supply',
      status: 'reviewer_approved',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'edit', entityType: 'need' }),
    );
    expect(surveys.generateSuggestedQuestions).toHaveBeenCalledWith('n1', [
      { domain: 'Water', subDomain: 'Supply' },
    ]);
    surveys.generateSuggestedQuestions.mockRejectedValue(new Error('gen'));
    await asActor(() =>
      svc.manualClassify('n1', { pairs: [{ domain: 'Water', subDomain: 'Supply' }] } as never),
    );
  });

  it('refuses a manual classification for an unknown need, a need that did not fail, or an inactive domain', async () => {
    const { svc, tx } = setup();
    const pairs = { pairs: [{ domain: 'Water', subDomain: 'Supply' }] } as never;
    tx.need.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.manualClassify('x', pairs))).rejects.toMatchObject({
      response: { error: { code: 'NEED_NOT_FOUND' } },
    });
    tx.need.findUnique.mockResolvedValueOnce(need({ status: 'ai_classified' }));
    await expect(asActor(() => svc.manualClassify('n1', pairs))).rejects.toMatchObject({
      response: { error: { code: 'NEED_NOT_FAILED' } },
    });
    tx.need.findUnique.mockResolvedValue(need({ status: 'draft' }));
    for (const bad of [
      { domain: 'Health', subDomain: 'x' },
      { domain: 'Water', subDomain: 'Retired' },
      { domain: 'Nope', subDomain: 'x' },
    ]) {
      await expect(
        asActor(() => svc.manualClassify('n1', { pairs: [bad] } as never)),
      ).rejects.toMatchObject({ response: { error: { code: 'INVALID_DOMAIN' } } });
    }
  });

  it('lists the decisions of a need with their confidence bands', async () => {
    const { svc, tx } = setup();
    tx.aiDecision.findMany.mockResolvedValue([
      {
        id: 'a',
        needId: 'n1',
        confidence: null,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        decidedAt: new Date('2026-03-02T00:00:00Z'),
        humanDecision: { decision: 'approved' },
      },
      {
        id: 'b',
        needId: 'n1',
        confidence: '0.4',
        createdAt: new Date('2026-03-01T00:00:00Z'),
        decidedAt: null,
        humanDecision: null,
      },
      {
        id: 'c',
        needId: 'n1',
        confidence: 0.1,
        createdAt: new Date('2026-03-01T00:00:00Z'),
        decidedAt: null,
        humanDecision: null,
      },
    ]);
    const decisions = await asActor(() => svc.listByNeedId('n1'));
    expect(decisions.map((d) => d.confidenceBand)).toEqual(['not_reported', 'low', 'very_low']);
    expect(decisions[0]!.decidedAt).toBe('2026-03-02T00:00:00.000Z');
  });
});
