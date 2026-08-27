import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  MethodologyConfigService,
  DEFAULT_AI_CLASSIFICATION_SETTINGS,
  DEFAULT_PRIORITY_FACTOR_SCALES,
} from './methodology-config.service';
import { orgContext } from '../../tenancy/org-context';
import type { MethodologyConfigRow } from './methodology-config.types';

const BASE_ROW: MethodologyConfigRow = {
  id: 'cfg-1',
  version: 'v5.0 - Approved methodology baseline',
  status: 'draft',
  publishedBy: null,
  publishedAt: null,
  reviewedBy: null,
  reviewedAt: null,
  reviewNotes: null,
  priorityThresholds: { criticalSeverity: 80, highSeverity: 70, mediumSeverity: 40, equityHighSeverity: 50 },
  priorityFactorWeights: [{ key: 'severity', label: 'Severity', weight: 0.2 }],
  confidenceFlagSettings: { dontKnowRatioThreshold: 0.2, minRespondentsForStandardConfidence: 10 },
  aiClassificationSettings: { lowConfidenceThreshold: 0.7, veryLowConfidenceThreshold: 0.4 },
  aiSummarySettings: { statementLengthThreshold: 1500, maxSummaryChars: 600 },
  priorityFactorScales: DEFAULT_PRIORITY_FACTOR_SCALES,
  updatedAt: new Date('2026-08-24T00:00:00Z'),
  updatedBy: null,
};

function pendingRow(overrides: Partial<MethodologyConfigRow> = {}): MethodologyConfigRow {
  return {
    ...BASE_ROW,
    status: 'pending_approval',
    updatedBy: 'admin-1',
    ...overrides,
  };
}

/** Captures whatever update() writes, so a test can assert on the persisted
 * JSON rather than only on the returned DTO. */
function makeService(row: Partial<MethodologyConfigRow> = {}) {
  const current = { ...BASE_ROW, ...row };
  const writes: Record<string, unknown>[] = [];
  // RIO-NFR-017's per-change snapshot, written by update()/approve()/reject()/publish().
  const history: Record<string, unknown>[] = [];
  const prisma = {
    methodologyConfig: {
      findFirst: async () => current,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(current, data);
        writes.push(data);
        return current;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => ({ ...BASE_ROW, ...data }),
    },
    methodologyConfigHistory: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        history.push(data);
        return data;
      },
      findMany: async () => history,
    },
  };
  // resolveActorName's cross-org user lookup — no user rows needed here.
  const tenant = { runAsSupervisor: async () => null };
  return {
    service: new MethodologyConfigService(prisma as never, tenant as never),
    row: current,
    writes,
    history,
  };
}

const ctx = { requestId: 'r', orgId: 'o1', actorId: 'me' };
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

describe('MethodologyConfigService — aiClassificationSettings (RIO-AI-001)', () => {
  it('exposes the configured thresholds through getRaw', async () => {
    const { service } = makeService();
    const raw = await service.getRaw();
    expect(raw.aiClassificationSettings).toEqual({ lowConfidenceThreshold: 0.7, veryLowConfidenceThreshold: 0.4 });
  });

  it('falls back to the documented defaults for a row written before the column existed', async () => {
    // Rows predating the migration read back as undefined — they must not
    // produce NaN thresholds, which would band every suggestion as low.
    const { service } = makeService({ aiClassificationSettings: undefined });
    const raw = await service.getRaw();
    expect(raw.aiClassificationSettings).toEqual(DEFAULT_AI_CLASSIFICATION_SETTINGS);
  });

  it('falls back per-field when the stored JSON is partial', async () => {
    const { service } = makeService({ aiClassificationSettings: { lowConfidenceThreshold: 0.6 } });
    const raw = await service.getRaw();
    expect(raw.aiClassificationSettings).toEqual({
      lowConfidenceThreshold: 0.6,
      veryLowConfidenceThreshold: DEFAULT_AI_CLASSIFICATION_SETTINGS.veryLowConfidenceThreshold,
    });
  });

  it('persists an updated threshold', async () => {
    const { service, writes } = makeService();
    await orgContext.run(ctx, () =>
      service.update({ aiClassificationSettings: { lowConfidenceThreshold: 0.85 } }),
    );
    expect(writes[0]?.aiClassificationSettings).toEqual({
      lowConfidenceThreshold: 0.85,
      veryLowConfidenceThreshold: 0.4,
    });
  });

  it('rejects a very-low threshold at or above the low threshold', async () => {
    // Otherwise the very_low band becomes unreachable while still looking
    // configured — a silently dead setting.
    const { service } = makeService();
    await expect(
      orgContext.run(ctx, () =>
        service.update({ aiClassificationSettings: { veryLowConfidenceThreshold: 0.7 } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('snapshots the AI thresholds into the config history', async () => {
    // RIO-NFR-017 records every configuration change. Without this family in
    // the snapshot, an edit that changed ONLY an AI confidence threshold
    // would write a history row identical to the one before it.
    const { service, history } = makeService();
    await orgContext.run(ctx, () =>
      service.update({ aiClassificationSettings: { lowConfidenceThreshold: 0.85 } }),
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.aiClassificationSettings).toEqual({
      lowConfidenceThreshold: 0.85,
      veryLowConfidenceThreshold: 0.4,
    });
  });

  it('leaves the other threshold families untouched when only this one is patched', async () => {
    const { service, writes } = makeService();
    await orgContext.run(ctx, () =>
      service.update({ aiClassificationSettings: { veryLowConfidenceThreshold: 0.2 } }),
    );
    expect(writes[0]?.priorityThresholds).toEqual(BASE_ROW.priorityThresholds);
    expect(writes[0]?.confidenceFlagSettings).toEqual(BASE_ROW.confidenceFlagSettings);
  });
});
