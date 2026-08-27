import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { MethodologyConfigService } from './methodology-config.service';
import { orgContext } from '../../tenancy/org-context';

interface FakeRow {
  id: string;
  version: string;
  status: string;
  publishedBy: string | null;
  publishedAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  priorityThresholds: unknown;
  priorityFactorWeights: unknown;
  confidenceFlagSettings: unknown;
  updatedAt: Date;
  updatedBy: string | null;
}

const baseThresholds = { criticalSeverity: 80, highSeverity: 70, mediumSeverity: 40, equityHighSeverity: 50 };
const baseWeights = [{ key: 'severity', label: 'Severity', weight: 0.2 }];
const baseConfidence = { dontKnowRatioThreshold: 0.2, minRespondentsForStandardConfidence: 10 };

function pendingRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 'cfg-1', version: 'v5.0', status: 'pending_approval',
    publishedBy: null, publishedAt: null,
    reviewedBy: null, reviewedAt: null, reviewNotes: null,
    priorityThresholds: baseThresholds, priorityFactorWeights: baseWeights, confidenceFlagSettings: baseConfidence,
    updatedAt: new Date(), updatedBy: 'admin-1',
    ...overrides,
  };
}

function makeService(initial: FakeRow) {
  const row = { ...initial };
  const history: unknown[] = [];
  const prisma = {
    methodologyConfig: {
      findFirst: async () => row,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(row, data);
        return row;
      },
    },
    methodologyConfigHistory: {
      create: async ({ data }: { data: unknown }) => {
        history.push(data);
        return data;
      },
      findMany: async () => [],
    },
  };
  const tenant = { runAsSupervisor: async (fn: (tx: unknown) => unknown) => fn({ user: { findUnique: async () => null } }) };
  const service = new MethodologyConfigService(prisma as never, tenant as never);
  return { service, row, history };
}

function runAsReviewer<T>(fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: 'r1', actorId: 'reviewer-1', role: 'system_reviewer' }, fn);
}
function runAsAdmin<T>(fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: 'r1', actorId: 'admin-1', role: 'system_admin' }, fn);
}

describe('MethodologyConfigService.update', () => {
  it('moves an approved config back to pending_approval on edit, clearing the prior review', async () => {
    const { service } = makeService(pendingRow({ status: 'approved', reviewedBy: 'reviewer-1', reviewedAt: new Date(), reviewNotes: 'ok' }));
    const result = await runAsAdmin(() => service.update({ priorityThresholds: { criticalSeverity: 85 } }));
    expect(result.status).toBe('pending_approval');
    expect(result.reviewedByName).toBeNull();
    expect(result.reviewNotes).toBeNull();
  });
});

describe('MethodologyConfigService.approve/reject', () => {
  it('requires reviewer notes to approve — rejects with empty notes', async () => {
    const { service } = makeService(pendingRow());
    await expect(runAsReviewer(() => service.approve(''))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('whitespace-only notes still fail', async () => {
    const { service } = makeService(pendingRow());
    await expect(runAsReviewer(() => service.reject('   '))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('approves with real notes — status becomes approved', async () => {
    const { service } = makeService(pendingRow());
    const result = await runAsReviewer(() => service.approve('Weights look correct.'));
    expect(result.status).toBe('approved');
    expect(result.reviewNotes).toBe('Weights look correct.');
  });

  it('rejects with real notes — status kicked back to draft for revision', async () => {
    const { service } = makeService(pendingRow());
    const result = await runAsReviewer(() => service.reject('Equity threshold looks wrong, please revise.'));
    expect(result.status).toBe('draft');
    expect(result.reviewNotes).toBe('Equity threshold looks wrong, please revise.');
  });

  it('cannot approve a config that is not pending approval', async () => {
    const { service } = makeService(pendingRow({ status: 'draft' }));
    await expect(runAsReviewer(() => service.approve('Notes'))).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('MethodologyConfigService.publish', () => {
  it('System Admin publishes an approved config', async () => {
    const { service } = makeService(pendingRow({ status: 'approved', reviewedBy: 'reviewer-1', reviewedAt: new Date(), reviewNotes: 'ok' }));
    const result = await runAsAdmin(() => service.publish());
    expect(result.status).toBe('published');
    expect(result.publishedByName).toBeNull();
  });

  it('cannot publish a config that has not been approved yet', async () => {
    const { service } = makeService(pendingRow({ status: 'pending_approval' }));
    await expect(runAsAdmin(() => service.publish())).rejects.toBeInstanceOf(ConflictException);
  });

  it('cannot publish a draft config that was never submitted for review', async () => {
    const { service } = makeService(pendingRow({ status: 'draft' }));
    await expect(runAsAdmin(() => service.publish())).rejects.toBeInstanceOf(ConflictException);
  });
});
