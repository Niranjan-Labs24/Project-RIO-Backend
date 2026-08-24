import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ConfigService } from '../../config/config.service';
import type { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { EvidenceFileCleanupService } from './evidence-file-cleanup.service';

// Modeled on backup.service.spec.ts's fakeSchedulerRegistry (asserting
// onModuleInit registers a cron job) and system-logs.service.spec.ts's
// runAsSupervisorWrite mock style (PendingFileDeletion is a global table
// with no org scoping, same as system_logs — see tenant-prisma.service.ts).

function fakeConfig(overrides: Partial<{ evidenceCleanupCron: string }> = {}): ConfigService {
  return {
    evidenceCleanupCron: overrides.evidenceCleanupCron ?? '0 4 * * *',
  } as unknown as ConfigService;
}

function fakeSchedulerRegistry(): SchedulerRegistry {
  return {
    addCronJob: vi.fn(),
  } as unknown as SchedulerRegistry;
}

interface FakePendingRow {
  id: string;
  storageKey: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

function fakeTenant(initial: FakePendingRow[] = []) {
  const rows = [...initial];
  const tenant = {
    runAsSupervisorWrite: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        pendingFileDeletion: {
          findMany: vi.fn(async () => [...rows]),
          delete: vi.fn(async ({ where }: { where: { id: string } }) => {
            const idx = rows.findIndex((r) => r.id === where.id);
            const [removed] = rows.splice(idx, 1);
            return removed;
          }),
          update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakePendingRow> }) => {
            const idx = rows.findIndex((r) => r.id === where.id);
            rows[idx] = { ...rows[idx], ...data } as FakePendingRow;
            return rows[idx];
          }),
        },
      }),
    ),
  } as unknown as TenantPrismaService;
  return { tenant, rows };
}

function fakeStorage(overrides: { remove?: (key: string) => Promise<boolean> } = {}) {
  return {
    remove: overrides.remove ?? (async () => true),
  };
}

describe('EvidenceFileCleanupService', () => {
  describe('onModuleInit', () => {
    it('registers a cron job on init using the configured schedule', () => {
      const scheduler = fakeSchedulerRegistry();
      const { tenant } = fakeTenant();
      const service = new EvidenceFileCleanupService(fakeConfig({ evidenceCleanupCron: '0 4 * * *' }), tenant, scheduler, fakeStorage() as never);

      service.onModuleInit();

      expect(scheduler.addCronJob).toHaveBeenCalledTimes(1);
      expect(scheduler.addCronJob).toHaveBeenCalledWith('evidence-file-cleanup', expect.anything());
    });
  });

  describe('sweep', () => {
    it('retries the physical delete and removes the row on success', async () => {
      const { tenant, rows } = fakeTenant([
        { id: 'pfd-1', storageKey: 'key-a', attempts: 0, lastError: null, createdAt: new Date('2026-01-01T00:00:00Z') },
      ]);
      const removedKeys: string[] = [];
      const storage = fakeStorage({
        remove: async (key) => {
          removedKeys.push(key);
          return true;
        },
      });
      const service = new EvidenceFileCleanupService(fakeConfig(), tenant, fakeSchedulerRegistry(), storage as never);

      await service.sweep();

      expect(removedKeys).toEqual(['key-a']);
      expect(rows).toHaveLength(0);
    });

    it('increments attempts and records lastError, leaving the row for the next sweep, when the retry fails', async () => {
      const { tenant, rows } = fakeTenant([
        { id: 'pfd-1', storageKey: 'key-a', attempts: 2, lastError: 'previous failure', createdAt: new Date('2026-01-01T00:00:00Z') },
      ]);
      const storage = fakeStorage({ remove: async () => false });
      const service = new EvidenceFileCleanupService(fakeConfig(), tenant, fakeSchedulerRegistry(), storage as never);

      await service.sweep();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.attempts).toBe(3);
      expect(rows[0]?.lastError).toBeTruthy();
    });

    it('never throws — a sweep error must not crash the process', async () => {
      const tenant = {
        runAsSupervisorWrite: vi.fn(async () => {
          throw new Error('db unreachable');
        }),
      } as unknown as TenantPrismaService;
      const service = new EvidenceFileCleanupService(fakeConfig(), tenant, fakeSchedulerRegistry(), fakeStorage() as never);

      await expect(service.sweep()).resolves.not.toThrow();
    });

    it('processes multiple pending rows independently (one failure does not block another row from being cleared)', async () => {
      const { tenant, rows } = fakeTenant([
        { id: 'pfd-1', storageKey: 'key-a', attempts: 0, lastError: null, createdAt: new Date('2026-01-01T00:00:00Z') },
        { id: 'pfd-2', storageKey: 'key-b', attempts: 0, lastError: null, createdAt: new Date('2026-01-01T00:00:00Z') },
      ]);
      const storage = fakeStorage({
        remove: async (key) => key === 'key-a',
      });
      const service = new EvidenceFileCleanupService(fakeConfig(), tenant, fakeSchedulerRegistry(), storage as never);

      await service.sweep();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.storageKey).toBe('key-b');
      expect(rows[0]?.attempts).toBe(1);
    });
  });
});
