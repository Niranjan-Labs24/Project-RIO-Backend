import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { MethodologyConfigService, DEFAULT_AI_CLASSIFICATION_SETTINGS } from './methodology-config.service';
import { orgContext } from '../../tenancy/org-context';
import type { MethodologyConfigRow } from './methodology-config.types';

const BASE_ROW: MethodologyConfigRow = {
  id: 'cfg-1',
  version: 'v5.0 - Approved methodology baseline',
  status: 'draft',
  publishedBy: null,
  publishedAt: null,
  priorityThresholds: { criticalSeverity: 80, highSeverity: 70, mediumSeverity: 40, equityHighSeverity: 50 },
  priorityFactorWeights: [{ key: 'severity', label: 'Severity', weight: 0.2 }],
  confidenceFlagSettings: { dontKnowRatioThreshold: 0.2, minRespondentsForStandardConfidence: 10 },
  aiClassificationSettings: { lowConfidenceThreshold: 0.7, veryLowConfidenceThreshold: 0.4 },
  updatedAt: new Date('2026-08-24T00:00:00Z'),
  updatedBy: null,
};

/** Captures whatever update() writes, so a test can assert on the persisted
 * JSON rather than only on the returned DTO. */
function makeService(row: Partial<MethodologyConfigRow> = {}) {
  const current = { ...BASE_ROW, ...row };
  const writes: Record<string, unknown>[] = [];
  // RIO-NFR-017's per-change snapshot, written by update()/publish().
  const history: Record<string, unknown>[] = [];
  const prisma = {
    methodologyConfig: {
      findFirst: async () => current,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { ...current, ...data };
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
    writes,
    history,
  };
}

const ctx = { requestId: 'r', orgId: 'o1', actorId: 'me' };

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
