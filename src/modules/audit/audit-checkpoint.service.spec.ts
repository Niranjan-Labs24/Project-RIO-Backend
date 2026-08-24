import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { AuditCheckpointService } from './audit-checkpoint.service';
import type { ConfigService } from '../../config/config.service';
import type { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import type { SystemLogsService } from '../system-logs/system-logs.service';

function fakeSystemLogs(): SystemLogsService {
  return { record: vi.fn() } as unknown as SystemLogsService;
}

const KEY = Buffer.alloc(32, 5).toString('base64');

function fakeConfig(overrides: Partial<{ auditCheckpointCron: string; auditSigningKey: string }> = {}): ConfigService {
  return {
    auditCheckpointCron: '0 * * * *',
    auditSigningKey: KEY,
    ...overrides,
  } as unknown as ConfigService;
}

function fakeSchedulerRegistry(): SchedulerRegistry {
  return { addCronJob: vi.fn() } as unknown as SchedulerRegistry;
}

const ROW = (id: string, createdAt: string) => ({
  id,
  organisationId: 'o1',
  actorUserId: null,
  action: 'create',
  entityType: 'x',
  entityId: null,
  entityLabel: 'L',
  sourceRef: null,
  metadata: null,
  ipAddress: null,
  userAgent: null,
  createdAt: new Date(createdAt),
});

/**
 * Fake TenantPrismaService: `checkpoints` and `auditRows` are the in-memory
 * "tables" the service reads/writes through runAsSupervisor (reads) and
 * runAsSupervisorWrite (checkpoint inserts) — mirroring the fakeTenant()
 * pattern already used in audit.service.spec.ts.
 */
function fakeTenant(auditRows: ReturnType<typeof ROW>[], checkpoints: Record<string, unknown>[] = []) {
  const tx = {
    auditCheckpoint: {
      // Insertion order is the real "creation order" here (Date.now() can
      // tie within a test's execution), so newest-first is just reversed
      // insertion order — sorting on createdAt would be flaky.
      findMany: async (args: { orderBy?: { createdAt?: 'asc' | 'desc' }; take?: number }) => {
        const ordered =
          args.orderBy?.createdAt === 'desc' ? [...checkpoints].reverse() : [...checkpoints];
        return args.take ? ordered.slice(0, args.take) : ordered;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, createdAt: data.createdAt ?? new Date() };
        checkpoints.push(row);
        return row;
      },
    },
    auditLog: {
      // Evaluates the small subset of Prisma where-shapes the service
      // actually builds (afterBoundary/uptoBoundary's OR of createdAt/id
      // comparisons, and their AND-combination) against a plain JS row.
      findMany: async (args: { where?: unknown }) => {
        const matches = (row: (typeof auditRows)[number], where: unknown): boolean => {
          if (!where || typeof where !== 'object') return true;
          const w = where as Record<string, unknown>;
          if (Array.isArray(w.AND)) return w.AND.every((c) => matches(row, c));
          if (Array.isArray(w.OR)) return w.OR.some((c) => matches(row, c));
          if ('createdAt' in w) {
            const c = w.createdAt as Date | { gt?: Date; lt?: Date } | undefined;
            if (c instanceof Date) {
              if (row.createdAt.getTime() !== c.getTime()) return false;
            } else if (c) {
              if (c.gt !== undefined && !(row.createdAt.getTime() > c.gt.getTime())) return false;
              if (c.lt !== undefined && !(row.createdAt.getTime() < c.lt.getTime())) return false;
            }
          }
          if ('id' in w) {
            const c = w.id as { gt?: string; lte?: string } | undefined;
            if (c?.gt !== undefined && !(row.id > c.gt)) return false;
            if (c?.lte !== undefined && !(row.id <= c.lte)) return false;
          }
          return true;
        };
        return auditRows
          .filter((r) => matches(r, args.where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      },
    },
  };
  const tenant = {
    runAsSupervisor: async (fn: (tx: unknown) => unknown) => fn(tx),
    runAsSupervisorWrite: async (fn: (tx: unknown) => unknown) => fn(tx),
  };
  return { tenant: tenant as unknown as TenantPrismaService, checkpoints, tx };
}

describe('AuditCheckpointService (GAP-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a cron job on init using the configured schedule', () => {
    const scheduler = fakeSchedulerRegistry();
    const { tenant } = fakeTenant([]);
    const service = new AuditCheckpointService(fakeConfig(), tenant, scheduler, fakeSystemLogs());

    service.onModuleInit();

    expect(scheduler.addCronJob).toHaveBeenCalledTimes(1);
    expect(scheduler.addCronJob).toHaveBeenCalledWith('audit-checkpoint', expect.anything());
  });

  it('genesis: with no prior checkpoint, covers every existing audit row from the start', async () => {
    const rows = [ROW('a', '2026-08-24T00:00:00Z'), ROW('b', '2026-08-24T00:00:01Z')];
    const { tenant, checkpoints } = fakeTenant(rows);
    const service = new AuditCheckpointService(fakeConfig(), tenant, fakeSchedulerRegistry(), fakeSystemLogs());

    await service.checkpoint();

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      prevChainHash: null,
      coveredFromId: 'a',
      coveredToId: 'b',
      rowCount: 2,
    });
  });

  it('incremental: a second run only covers rows after the last checkpoint boundary, chained to its signature', async () => {
    const rows = [ROW('a', '2026-08-24T00:00:00Z'), ROW('b', '2026-08-24T00:00:01Z')];
    const { tenant, checkpoints } = fakeTenant(rows);
    const service = new AuditCheckpointService(fakeConfig(), tenant, fakeSchedulerRegistry(), fakeSystemLogs());
    await service.checkpoint();
    const first = checkpoints[0] as { signature: string; coveredToId: string };

    // New rows arrive after the first checkpoint's boundary.
    rows.push(ROW('c', '2026-08-24T00:00:02Z'));
    await service.checkpoint();

    expect(checkpoints).toHaveLength(2);
    const second = checkpoints[1] as { prevChainHash: string; coveredFromId: string; coveredToId: string; rowCount: number };
    expect(second.prevChainHash).toBe(first.signature);
    expect(second.coveredFromId).toBe('c');
    expect(second.coveredToId).toBe('c');
    expect(second.rowCount).toBe(1);
  });

  it('no-op: a run with nothing new since the last checkpoint writes nothing', async () => {
    const rows = [ROW('a', '2026-08-24T00:00:00Z')];
    const { tenant, checkpoints } = fakeTenant(rows);
    const service = new AuditCheckpointService(fakeConfig(), tenant, fakeSchedulerRegistry(), fakeSystemLogs());
    await service.checkpoint();
    expect(checkpoints).toHaveLength(1);

    await service.checkpoint();
    expect(checkpoints).toHaveLength(1);
  });

  it('never throws even if the read path fails', async () => {
    const tenant = {
      runAsSupervisor: async () => {
        throw new Error('db down');
      },
      runAsSupervisorWrite: async (fn: (tx: unknown) => unknown) => fn({}),
    } as unknown as TenantPrismaService;
    const service = new AuditCheckpointService(fakeConfig(), tenant, fakeSchedulerRegistry(), fakeSystemLogs());

    await expect(service.checkpoint()).resolves.toBeUndefined();
  });

  describe('off-box mirror (GAP-02 Task 5 first cut)', () => {
    it('mirrors a new checkpoint to SystemLogsService, first-cut off-box anchor', async () => {
      const rows = [ROW('a', '2026-08-24T00:00:00Z'), ROW('b', '2026-08-24T00:00:01Z')];
      const { tenant, checkpoints } = fakeTenant(rows);
      const systemLogs = fakeSystemLogs();
      const service = new AuditCheckpointService(fakeConfig(), tenant, fakeSchedulerRegistry(), systemLogs);

      await service.checkpoint();

      const created = checkpoints[0] as { id: string; coveredToId: string; digest: string; signature: string };
      expect(systemLogs.record).toHaveBeenCalledTimes(1);
      expect(systemLogs.record).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          category: 'job',
          source: 'AuditCheckpointService',
          eventCode: 'AUDIT_CHECKPOINT_CREATED',
          context: expect.objectContaining({
            id: created.id,
            coveredToId: created.coveredToId,
            digest: created.digest,
            signature: created.signature,
          }),
        }),
      );
    });

    it('does not mirror when there is nothing new to checkpoint', async () => {
      const rows = [ROW('a', '2026-08-24T00:00:00Z')];
      const { tenant } = fakeTenant(rows);
      const systemLogs = fakeSystemLogs();
      const service = new AuditCheckpointService(fakeConfig(), tenant, fakeSchedulerRegistry(), systemLogs);
      await service.checkpoint();
      vi.mocked(systemLogs.record).mockClear();

      await service.checkpoint();

      expect(systemLogs.record).not.toHaveBeenCalled();
    });

    it('a mirror failure never fails the checkpoint run itself', async () => {
      const rows = [ROW('a', '2026-08-24T00:00:00Z')];
      const { tenant, checkpoints } = fakeTenant(rows);
      const systemLogs = {
        record: vi.fn(() => {
          throw new Error('mirror down');
        }),
      } as unknown as SystemLogsService;
      const service = new AuditCheckpointService(fakeConfig(), tenant, fakeSchedulerRegistry(), systemLogs);

      await expect(service.checkpoint()).resolves.toBeUndefined();
      // The checkpoint itself still landed — only the best-effort mirror failed.
      expect(checkpoints).toHaveLength(1);
    });
  });
});
