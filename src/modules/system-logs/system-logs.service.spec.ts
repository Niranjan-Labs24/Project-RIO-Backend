import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '../../config/config.service';
import type { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { orgContext } from '../../tenancy/org-context';
import { SystemLogsService, sanitizeContext } from './system-logs.service';
import type { SystemLogLevel } from './system-logs.types';

interface Captured {
  data: Record<string, unknown>[];
}

function makeTenant(overrides: Partial<Record<string, unknown>> = {}) {
  const captured: Captured = { data: [] };
  const tenant = {
    runAsSupervisorWrite: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        systemLog: {
          createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
            captured.data.push(...data);
            return { count: data.length };
          }),
        },
        $executeRaw: vi.fn(async () => 0),
      }),
    ),
    runAsSupervisor: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    ...overrides,
  } as unknown as TenantPrismaService;
  return { tenant, captured };
}

function makeConfig(over: Partial<{ enabled: boolean; minLevel: SystemLogLevel }> = {}) {
  return {
    systemLogEnabled: over.enabled ?? true,
    systemLogMinLevel: over.minLevel ?? 'info',
    systemLogSampleRate: 0,
    systemLogSlowRequestMs: 3000,
    systemLogRetentionDays: 90,
    systemLogRetentionCron: '0 3 * * *',
  } as unknown as ConfigService;
}

describe('SystemLogsService.record', () => {
  it('buffers and flushes a batched insert', async () => {
    const { tenant, captured } = makeTenant();
    const service = new SystemLogsService(tenant, makeConfig());

    service.record({ level: 'error', category: 'integration', source: 'MailerService', message: 'boom' });
    // Nothing hits the database until a flush — record() never awaits.
    expect(captured.data).toHaveLength(0);

    await service.flush();
    expect(captured.data).toHaveLength(1);
    expect(captured.data[0]).toMatchObject({
      level: 'error',
      category: 'integration',
      source: 'MailerService',
      message: 'boom',
    });
  });

  it('stamps correlation fields from the ambient org context', async () => {
    const { tenant, captured } = makeTenant();
    const service = new SystemLogsService(tenant, makeConfig());

    await orgContext.run(
      {
        requestId: 'req-1',
        orgId: '11111111-1111-1111-1111-111111111111',
        actorId: '22222222-2222-2222-2222-222222222222',
        ip: '10.0.0.1',
        userAgent: 'vitest',
      },
      async () => {
        service.record({ level: 'warn', category: 'auth', source: 'AuthService', message: 'denied' });
        await service.flush();
      },
    );

    expect(captured.data[0]).toMatchObject({
      requestId: 'req-1',
      organisationId: '11111111-1111-1111-1111-111111111111',
      actorUserId: '22222222-2222-2222-2222-222222222222',
      ipAddress: '10.0.0.1',
      userAgent: 'vitest',
    });
  });

  it('is a no-op when disabled', async () => {
    const { tenant, captured } = makeTenant();
    const service = new SystemLogsService(tenant, makeConfig({ enabled: false }));
    service.record({ level: 'error', category: 'http', source: 's', message: 'm' });
    await service.flush();
    expect(captured.data).toHaveLength(0);
  });

  it('discards levels below SYSTEM_LOG_MIN_LEVEL but keeps louder ones', async () => {
    const { tenant, captured } = makeTenant();
    const service = new SystemLogsService(tenant, makeConfig({ minLevel: 'warn' }));
    service.record({ level: 'info', category: 'http', source: 's', message: 'chatty' });
    service.record({ level: 'error', category: 'http', source: 's', message: 'real' });
    await service.flush();
    expect(captured.data).toHaveLength(1);
    expect(captured.data[0]).toMatchObject({ message: 'real' });
  });

  it('never throws when the database write fails', async () => {
    const tenant = {
      runAsSupervisorWrite: vi.fn(async () => {
        throw new Error('db down');
      }),
      runAsSupervisor: vi.fn(),
    } as unknown as TenantPrismaService;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new SystemLogsService(tenant, makeConfig());

    service.record({ level: 'error', category: 'database', source: 's', message: 'm' });
    await expect(service.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('truncates an oversized stack rather than storing it whole', async () => {
    const { tenant, captured } = makeTenant();
    const service = new SystemLogsService(tenant, makeConfig());
    const err = new Error('big');
    err.stack = 'x'.repeat(20_000);

    service.record({ level: 'error', category: 'application', source: 's', message: 'm', error: err });
    await service.flush();

    expect((captured.data[0]?.stack as string).length).toBe(8_192);
  });

  it('truncates an over-long message to the column width', async () => {
    const { tenant, captured } = makeTenant();
    const service = new SystemLogsService(tenant, makeConfig());
    service.record({ level: 'error', category: 'application', source: 's', message: 'm'.repeat(5_000) });
    await service.flush();
    expect((captured.data[0]?.message as string).length).toBe(2_000);
  });

  it('flushes anything still buffered on shutdown', async () => {
    const { tenant, captured } = makeTenant();
    const service = new SystemLogsService(tenant, makeConfig());
    service.record({ level: 'info', category: 'startup', source: 's', message: 'bye' });
    await service.onModuleDestroy();
    expect(captured.data).toHaveLength(1);
  });

  it('drops the oldest entries rather than growing the buffer without bound', async () => {
    const { tenant, captured } = makeTenant();
    const service = new SystemLogsService(tenant, makeConfig());
    // Flushing is what empties the buffer; stub it out so the ceiling is
    // what's under test rather than the flush cadence.
    const flush = vi.spyOn(service, 'flush').mockResolvedValue(undefined);
    for (let i = 0; i < 5_200; i++) {
      service.record({ level: 'error', category: 'http', source: 's', message: `m${i}` });
    }
    flush.mockRestore();
    await service.flush();

    expect(captured.data).toHaveLength(5_000);
    // The survivors are the newest ones — the oldest 200 were dropped.
    expect(captured.data[0]).toMatchObject({ message: 'm200' });
  });
});

describe('sanitizeContext', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = sanitizeContext({
      provider: 'smtp',
      password: 'hunter2',
      nested: { apiKey: 'abc', refreshToken: 'xyz', safe: 1 },
    });
    expect(out).toEqual({
      provider: 'smtp',
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', refreshToken: '[REDACTED]', safe: 1 },
    });
  });

  it('redacts a bare JWT even under an innocuous key', () => {
    const out = sanitizeContext({
      note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    });
    expect(out).toEqual({ note: '[REDACTED]' });
  });

  it('caps an oversized context and flags the truncation', () => {
    const out = sanitizeContext({ blob: 'y'.repeat(40_000) }) as Record<string, unknown>;
    expect(out._truncated).toBe(true);
    expect((out._preview as string).length).toBe(16_384);
  });

  it('returns undefined for no context', () => {
    expect(sanitizeContext(undefined)).toBeUndefined();
  });
});

describe('SystemLogsService.getById', () => {
  it('throws the standard not-found envelope for an unknown id', async () => {
    const tenant = {
      runAsSupervisor: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ systemLog: { findUnique: vi.fn(async () => null) } }),
      ),
      runAsSupervisorWrite: vi.fn(),
    } as unknown as TenantPrismaService;
    const service = new SystemLogsService(tenant, makeConfig());

    await expect(service.getById('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
