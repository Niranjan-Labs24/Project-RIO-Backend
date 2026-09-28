import { describe, expect, it, vi } from 'vitest';
import { SystemLogsService } from './system-logs.service';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  level: 'error',
  category: 'http',
  source: 'Api',
  eventCode: 'HTTP_500',
  message: 'boom',
  requestId: 'req-1',
  organisationId: 'org-1',
  actorUserId: 'u1',
  httpMethod: 'GET',
  httpPath: '/x',
  statusCode: 500,
  durationMs: 12,
  ipAddress: '1.2.3.4',
  userAgent: 'ua',
  stack: null,
  context: { a: 1 },
  instanceId: 'i1',
  createdAt: new Date('2026-05-01T00:00:00Z'),
  ...over,
});

function setup(txOver: Record<string, unknown> = {}) {
  const tx = {
    systemLog: {
      findMany: vi.fn().mockResolvedValue([row()]),
      findUnique: vi.fn().mockResolvedValue(row()),
      findFirst: vi.fn().mockResolvedValue({ message: 'sample' }),
      count: vi.fn().mockResolvedValue(1),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    organisation: { findMany: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Acme' }]) },
    user: { findMany: vi.fn().mockResolvedValue([{ id: 'u1', name: 'Ana', email: 'ana@x.test' }]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(3),
    ...txOver,
  };
  const tenant = {
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsSupervisorWrite: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  const config = { systemLogEnabled: true, systemLogMinLevel: 'info', get: () => undefined };
  return { tx, svc: new SystemLogsService(tenant as never, config as never) };
}

describe('SystemLogsService.list', () => {
  it('returns mapped entries with organization and actor names and clamps paging', async () => {
    const { svc, tx } = setup();
    const result = await svc.list({ limit: 9999, offset: -5 });
    expect(result).toMatchObject({ total: 1, limit: 200, offset: 0 });
    expect(result.items[0]).toMatchObject({
      organizationName: 'Acme',
      actor: { email: 'ana@x.test' },
      http: { method: 'GET', path: '/x', statusCode: 500, durationMs: 12 },
      context: { a: 1 },
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    expect(tx.systemLog.findMany.mock.calls[0]![0]).toMatchObject({ take: 200, skip: 0 });
  });

  it('uses sensible defaults, and leaves unknown organizations and actors null', async () => {
    const { svc, tx } = setup();
    tx.systemLog.findMany.mockResolvedValue([
      row({ organisationId: 'org-x', actorUserId: 'u-x', context: [1, 2] }),
    ]);
    const result = await svc.list({});
    expect(result.limit).toBe(50);
    expect(result.items[0]).toMatchObject({ organizationName: null, actor: null, context: null });
  });

  it('returns no lookups for rows without an organization or actor, and nothing for no rows', async () => {
    const { svc, tx } = setup();
    tx.systemLog.findMany.mockResolvedValue([
      row({ organisationId: null, actorUserId: null, context: null }),
    ]);
    await svc.list({});
    expect(tx.organisation.findMany).not.toHaveBeenCalled();
    expect(tx.user.findMany).not.toHaveBeenCalled();
    tx.systemLog.findMany.mockResolvedValue([]);
    expect((await svc.list({})).items).toEqual([]);
  });

  it('builds the filter from every supported option', async () => {
    const { svc, tx } = setup();
    await svc.list({
      level: 'warn',
      category: 'http' as never,
      source: 'Api',
      eventCode: 'X',
      requestId: 'r',
      organizationId: 'o',
      actorId: 'a',
      statusCode: 404,
      dateFrom: '2026-01-01',
      dateTo: '2026-02-01',
      search: '  boom ',
    });
    const where = tx.systemLog.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      level: 'warn',
      category: 'http',
      source: 'Api',
      eventCode: 'X',
      requestId: 'r',
      organisationId: 'o',
      actorUserId: 'a',
      statusCode: 404,
    });
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
    expect(where.OR).toHaveLength(2);
  });

  it('turns a minimum level into the list of levels at or above it, and accepts a one-sided date range', async () => {
    const { svc, tx } = setup();
    await svc.list({ minLevel: 'warn', dateFrom: '2026-01-01' });
    const where = tx.systemLog.findMany.mock.calls[0]![0].where;
    expect(where.level.in).toEqual(expect.arrayContaining(['fatal', 'error', 'warn']));
    expect(where.createdAt).toHaveProperty('gte');
    expect(where.createdAt).not.toHaveProperty('lte');
    await svc.list({ dateTo: '2026-01-01' });
    expect(tx.systemLog.findMany.mock.calls[1]![0].where.createdAt).toHaveProperty('lte');
  });

  it('rejects an invalid date filter as a validation error', async () => {
    const { svc } = setup();
    await expect(svc.list({ dateFrom: 'nope' })).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
  });
});

describe('SystemLogsService lookups', () => {
  it('returns one entry, and a not-found envelope when it is missing', async () => {
    const { svc, tx } = setup();
    expect((await svc.getById('l1')).id).toBe('l1');
    tx.systemLog.findUnique.mockResolvedValue(null);
    await expect(svc.getById('x')).rejects.toMatchObject({
      response: { error: { code: 'SYSTEM_LOG_NOT_FOUND' } },
    });
  });

  it('returns every entry of one request, oldest first', async () => {
    const { svc, tx } = setup();
    expect((await svc.getByRequestId('req-1')).items).toHaveLength(1);
    expect(tx.systemLog.findMany.mock.calls[0]![0]).toMatchObject({
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
  });
});

describe('SystemLogsService.getSummary', () => {
  it('summarises counts, categories, top codes and the error trend', async () => {
    const { svc, tx } = setup();
    tx.systemLog.count.mockResolvedValue(10);
    tx.systemLog.groupBy
      .mockResolvedValueOnce([
        { level: 'error', _count: { _all: 4 } },
        { level: 'warn', _count: { _all: 6 } },
      ])
      .mockResolvedValueOnce([{ category: 'http', _count: { _all: 10 } }])
      .mockResolvedValueOnce([
        {
          eventCode: 'HTTP_500',
          _count: { _all: 4 },
          _max: { createdAt: new Date('2026-05-01T00:00:00Z') },
        },
        { eventCode: 'X', _count: { _all: 1 }, _max: { createdAt: null } },
      ]);
    tx.systemLog.findMany.mockResolvedValue([{ requestId: 'a' }, { requestId: 'b' }]);
    tx.systemLog.findFirst.mockResolvedValueOnce({ message: 'boom' }).mockResolvedValueOnce(null);
    tx.$queryRaw.mockResolvedValue([{ hour: new Date('2026-05-01T01:00:00Z'), count: BigInt(3) }]);

    const summary = await svc.getSummary('7d');
    expect(summary.window).toBe('7d');
    expect(summary.stats).toMatchObject({
      total: 10,
      error: 4,
      warn: 6,
      fatal: 0,
      info: 0,
      failedRequests: 2,
    });
    expect(summary.topEventCodes[0]).toMatchObject({
      eventCode: 'HTTP_500',
      sampleMessage: 'boom',
    });
    expect(summary.topEventCodes[1]!.sampleMessage).toBe('');
    expect(summary.errorTrend).toEqual([{ hour: '2026-05-01T01:00:00.000Z', count: 3 }]);
  });

  it('defaults to a 24 hour window', async () => {
    const { svc } = setup();
    expect((await svc.getSummary()).window).toBe('24h');
  });
});

describe('SystemLogsService export and purge', () => {
  it('exports a CSV with a header, escaped quotes and empty cells', async () => {
    const { svc, tx } = setup();
    tx.systemLog.findMany.mockResolvedValue([
      row({
        message: 'say "hi"',
        statusCode: null,
        durationMs: null,
        eventCode: null,
        requestId: null,
        organisationId: null,
        actorUserId: null,
        ipAddress: null,
      }),
    ]);
    const csv = await svc.exportCsv({ level: 'error' });
    const [header, body] = csv.split('\n');
    expect(header).toContain('"Timestamp"');
    expect(body).toContain('"say ""hi"""');
  });

  it('purges old rows in chunks and reports how many went', async () => {
    const { svc, tx } = setup();
    expect(await svc.purgeBatch(new Date('2026-01-01T00:00:00Z'), 50)).toBe(3);
    expect(tx.$executeRaw).toHaveBeenCalled();
  });
});

describe('SystemLogsService.record edge cases', () => {
  it('stores string, unserialisable and circular errors and contexts safely', async () => {
    const { svc, tx } = setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const created: unknown[] = [];
    (tx as never as { systemLog: { createMany: unknown } }).systemLog.createMany = vi.fn(
      async ({ data }: { data: unknown[] }) => {
        created.push(...data);
      },
    );
    svc.record({
      level: 'error',
      category: 'http' as never,
      source: 'S',
      message: 'm',
      error: 'text error',
    });
    svc.record({
      level: 'error',
      category: 'http' as never,
      source: 'S',
      message: 'm',
      error: { code: 1 },
    });
    svc.record({
      level: 'error',
      category: 'http' as never,
      source: 'S',
      message: 'm',
      error: circular,
      context: { big: BigInt(1) } as never,
    });
    svc.record({
      level: 'error',
      category: 'http' as never,
      source: 'S',
      message: 'm',
      http: { method: 'GET', path: '/'.repeat(600), statusCode: 500, durationMs: 1 },
      organisationId: 'o1',
      eventCode: 'E'.repeat(100),
    });
    await svc.flush();
    expect(created).toHaveLength(4);
    await svc.flush(); // nothing left to write
  });

  it('schedules a flush and flushes early when a batch fills', async () => {
    vi.useFakeTimers();
    try {
      const { svc, tx } = setup();
      const createMany = vi.fn().mockResolvedValue({ count: 1 });
      (tx as never as { systemLog: { createMany: unknown } }).systemLog.createMany = createMany;
      svc.record({ level: 'error', category: 'http' as never, source: 'S', message: 'a' });
      svc.record({ level: 'error', category: 'http' as never, source: 'S', message: 'b' });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(createMany).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 100; i++)
        svc.record({ level: 'error', category: 'http' as never, source: 'S', message: `m${i}` });
      await vi.advanceTimersByTimeAsync(10);
      expect(createMany).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
