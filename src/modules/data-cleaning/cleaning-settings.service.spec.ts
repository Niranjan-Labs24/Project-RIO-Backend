import { describe, expect, it, vi } from 'vitest';
import { makeFakeTx } from '../../../test/support/fake-tx';
import { orgContext } from '../../tenancy/org-context';
import { CleaningSettingsService } from './cleaning-settings.service';
import { DEFAULT_SETTINGS } from './data-cleaning.types';

function setup() {
  const prisma = makeFakeTx();
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const context = { invalidate: vi.fn() };
  const svc = new CleaningSettingsService(prisma as never, audit as never, context as never);
  return { prisma, audit, context, svc };
}
const as = <T>(role: string | undefined, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1', role } as never, fn);
const config = (stored: unknown = null) => ({
  id: 'c1',
  version: 'v1',
  status: 'PUBLISHED',
  dataCleaningSettings: stored,
  priorityThresholds: {},
  priorityFactorWeights: {},
  priorityFactorScales: {},
  confidenceFlagSettings: {},
  aiClassificationSettings: {},
  aiSummarySettings: {},
});
const code = (c: string) =>
  expect.objectContaining({ response: { error: expect.objectContaining({ code: c }) } });

describe('CleaningSettingsService.get', () => {
  it('overlays stored settings on the defaults', async () => {
    const { prisma, svc } = setup();
    prisma.methodologyConfig.findFirst
      .mockResolvedValueOnce(config({ literalDuplicateThreshold: 0.9 }))
      .mockResolvedValueOnce(config());
    expect(await svc.get()).toMatchObject({
      literalDuplicateThreshold: 0.9,
      methodologyVersion: 'v1',
    });
    expect(await svc.get()).toMatchObject({ ...DEFAULT_SETTINGS, methodologyVersion: 'v1' });
  });

  it('refuses when no methodology configuration exists', async () => {
    const { svc } = setup();
    await expect(svc.get()).rejects.toThrow(code('NO_METHODOLOGY_CONFIG'));
  });
});

describe('CleaningSettingsService.update', () => {
  it('applies a patch, records history, clears the cache and audits only real changes', async () => {
    const { prisma, svc, audit, context } = setup();
    prisma.methodologyConfig.findFirst.mockResolvedValue(
      config({ literalDuplicateThreshold: 0.9 }),
    );
    prisma.methodologyConfig.update.mockResolvedValue({
      id: 'c1',
      version: 'v1',
      status: 'PUBLISHED',
    });
    const out = await as('ngo_admin', () =>
      svc.update({
        literalDuplicateThreshold: 0.95,
        semanticDuplicateThreshold: DEFAULT_SETTINGS.semanticDuplicateThreshold,
      } as never),
    );
    expect(out.literalDuplicateThreshold).toBe(0.95);
    expect(prisma.methodologyConfigHistory.create).toHaveBeenCalled();
    expect(context.invalidate).toHaveBeenCalled();
    expect(audit.record.mock.calls[0]![0].changes).toHaveLength(1);
  });

  it('skips the audit when nothing changed', async () => {
    const { prisma, svc, audit } = setup();
    prisma.methodologyConfig.findFirst.mockResolvedValue(config());
    prisma.methodologyConfig.update.mockResolvedValue({
      id: 'c1',
      version: 'v1',
      status: 'PUBLISHED',
    });
    await as('ngo_admin', () => svc.update({}));
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses without a configuration, and out-of-range or badly ordered thresholds', async () => {
    const { prisma, svc } = setup();
    await expect(as('ngo_admin', () => svc.update({}))).rejects.toThrow(
      code('NO_METHODOLOGY_CONFIG'),
    );
    prisma.methodologyConfig.findFirst.mockResolvedValue(config());
    await expect(
      as('ngo_admin', () => svc.update({ semanticDuplicateThreshold: 0.1 } as never)),
    ).rejects.toThrow(code('THRESHOLD_OUT_OF_RANGE'));
    await expect(
      as('ngo_admin', () =>
        svc.update({
          villageMatchProposeThreshold: 0.99,
          villageMatchAcceptThreshold: 0.6,
        } as never),
      ),
    ).rejects.toThrow(code('THRESHOLD_ORDER'));
  });

  it('only lets cross-entity readers switch on cross-entity duplicate matching', async () => {
    const { prisma, svc } = setup();
    prisma.methodologyConfig.findFirst.mockResolvedValue(config());
    prisma.methodologyConfig.update.mockResolvedValue({
      id: 'c1',
      version: 'v1',
      status: 'PUBLISHED',
    });
    const patch = { duplicateScopes: { crossOrg: true } } as never;
    await expect(as('ngo_admin', () => svc.update(patch))).rejects.toThrow(
      code('CROSS_ORG_SCOPE_FORBIDDEN'),
    );
    await as('system_admin', () => svc.update(patch));
  });
});
