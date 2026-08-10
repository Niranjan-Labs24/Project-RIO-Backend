import { describe, expect, it, vi } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PERMISSION_KEY } from '../../common/guards/permission.guard';
import { SystemLogsController } from './system-logs.controller';
import type { SystemLogsService } from './system-logs.service';

/**
 * RIO-NFR-016. Two things are asserted here:
 *
 * 1. The route surface is read-only and gated on `systemLogs`. Operational
 *    rows are written from inside the process only; the sole deletion path
 *    is the retention job, which is deliberately not reachable over HTTP. A
 *    future @Post()/@Delete() added to this controller fails these tests,
 *    which is the point.
 * 2. Query-string values that aren't valid enum members are dropped rather
 *    than passed through — an unknown `?level=lol` must widen back to
 *    unfiltered, never reach Prisma as an invalid enum and 500.
 */

function handlerOf(name: string): object {
  return (SystemLogsController.prototype as unknown as Record<string, unknown>)[name] as object;
}

function routeMethod(name: string): number | undefined {
  return Reflect.getMetadata(METHOD_METADATA, handlerOf(name)) as number | undefined;
}

function routePath(name: string): string | undefined {
  return Reflect.getMetadata(PATH_METADATA, handlerOf(name)) as string | undefined;
}

function routePermission(name: string): { module: string; action: string } | undefined {
  return Reflect.getMetadata(PERMISSION_KEY, handlerOf(name)) as
    | { module: string; action: string }
    | undefined;
}

function decoratedHandlers(): string[] {
  return Object.getOwnPropertyNames(SystemLogsController.prototype)
    .filter((n) => n !== 'constructor')
    .filter((n) => routeMethod(n) !== undefined);
}

function makeService() {
  return {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 }),
    getSummary: vi.fn().mockResolvedValue({}),
    getById: vi.fn().mockResolvedValue({}),
    getByRequestId: vi.fn().mockResolvedValue({ items: [] }),
    exportCsv: vi.fn().mockResolvedValue('csv'),
  } as unknown as SystemLogsService & Record<string, ReturnType<typeof vi.fn>>;
}

describe('SystemLogsController route surface', () => {
  it('exposes GET routes only — no write, update, or delete path exists', () => {
    for (const name of decoratedHandlers()) {
      expect(routeMethod(name), `${name} must be a GET`).toBe(RequestMethod.GET);
    }
  });

  it('gates every route on the systemLogs module', () => {
    for (const name of decoratedHandlers()) {
      expect(routePermission(name)?.module, `${name} permission module`).toBe('systemLogs');
    }
  });

  it('gates the CSV download on export, and everything else on read', () => {
    expect(routePermission('export')).toEqual({ module: 'systemLogs', action: 'export' });
    for (const name of decoratedHandlers().filter((n) => n !== 'export')) {
      expect(routePermission(name)?.action, `${name} action`).toBe('read');
    }
  });

  it('declares the literal paths before the :id route', () => {
    const paths = decoratedHandlers().map(routePath);
    // Order matters at runtime: ':id' would otherwise swallow 'summary'.
    expect(paths.indexOf(':id')).toBe(paths.length - 1);
    expect(paths).toContain('summary');
    expect(paths).toContain('export');
    expect(paths).toContain('request/:requestId');
  });
});

describe('SystemLogsController filter parsing', () => {
  it('passes valid filters straight through', async () => {
    const service = makeService();
    const controller = new SystemLogsController(service);

    await controller.list(
      '25', '50', 'error', undefined, 'integration', 'MailerService', 'MAILER_SEND_FAILED',
      'req-1', 'org-1', 'user-1', '500', '2026-08-01T00:00:00Z', '2026-08-07T00:00:00Z', 'timeout',
    );

    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 25,
        offset: 50,
        level: 'error',
        category: 'integration',
        source: 'MailerService',
        eventCode: 'MAILER_SEND_FAILED',
        requestId: 'req-1',
        organizationId: 'org-1',
        actorId: 'user-1',
        statusCode: 500,
        search: 'timeout',
      }),
    );
  });

  it('drops an invalid level/category instead of forwarding it to Prisma', async () => {
    const service = makeService();
    const controller = new SystemLogsController(service);

    await controller.list(undefined, undefined, 'catastrophe', undefined, 'not-a-category');

    const arg = vi.mocked(service.list).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.level).toBeUndefined();
    expect(arg.category).toBeUndefined();
  });

  it('falls back to the 24h window for an unknown ?window value', async () => {
    const service = makeService();
    const controller = new SystemLogsController(service);

    await controller.getSummary('all-time');
    expect(service.getSummary).toHaveBeenCalledWith('24h');

    await controller.getSummary('7d');
    expect(service.getSummary).toHaveBeenCalledWith('7d');
  });

  it('sets the CSV download headers', async () => {
    const service = makeService();
    const controller = new SystemLogsController(service);
    const set = vi.fn();

    const csv = await controller.export({ set } as never);

    expect(csv).toBe('csv');
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Type': 'text/csv',
        'Content-Disposition': expect.stringContaining('attachment; filename="system-logs-'),
      }),
    );
  });
});
