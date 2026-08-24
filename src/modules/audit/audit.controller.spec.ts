import { describe, expect, it, vi } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PERMISSION_KEY } from '../../common/guards/permission.guard';
import { AuditController } from './audit.controller';

/**
 * RIO-FR-007 AC2 — "the log cannot be deleted from the standard user
 * interface". The UI can only call what the controller exposes, so the
 * guarantee lives here: this asserts the route surface itself is read-only
 * and stays that way. A future `@Delete()`/`@Post()` added to this controller
 * fails these tests, which is the point — the check has to survive the
 * developer who did not read the requirement.
 */

const HANDLERS = ['list', 'export', 'getSummary', 'getById', 'getIntegrity'] as const;

function routeMethod(name: string): number | undefined {
  const handler = (AuditController.prototype as unknown as Record<string, unknown>)[name];
  return Reflect.getMetadata(METHOD_METADATA, handler as object) as number | undefined;
}

function routePath(name: string): string | undefined {
  const handler = (AuditController.prototype as unknown as Record<string, unknown>)[name];
  return Reflect.getMetadata(PATH_METADATA, handler as object) as string | undefined;
}

function routePermission(name: string): { module: string; action: string } | undefined {
  const handler = (AuditController.prototype as unknown as Record<string, unknown>)[name];
  return Reflect.getMetadata(PERMISSION_KEY, handler as object) as
    | { module: string; action: string }
    | undefined;
}

/** Every own method on the controller prototype that carries a route decorator. */
function decoratedHandlers(): string[] {
  return Object.getOwnPropertyNames(AuditController.prototype)
    .filter((n) => n !== 'constructor')
    .filter((n) => routeMethod(n) !== undefined);
}

describe('AuditController route surface (RIO-FR-007 AC2 — no deletion path)', () => {
  it('exposes exactly the four read routes and nothing else', () => {
    expect(decoratedHandlers().sort()).toEqual([...HANDLERS].sort());
  });

  it('every route is a GET — no POST/PUT/PATCH/DELETE anywhere on the controller', () => {
    for (const name of decoratedHandlers()) {
      expect.soft(routeMethod(name), `${name} must be a GET`).toBe(RequestMethod.GET);
    }
  });

  it('has no delete/purge/clear handler at all, decorated or not', () => {
    // Not just "no @Delete()" — no such method exists to be wired up later
    // from another controller or a direct service call in a resolver.
    const suspicious = Object.getOwnPropertyNames(AuditController.prototype).filter((n) =>
      /delete|remove|purge|clear|destroy|truncate|reset/i.test(n),
    );
    expect(suspicious).toEqual([]);
  });

  it('is mounted at /audit', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AuditController)).toBe('audit');
  });
});

describe('AuditController permission gating (RIO-FR-007)', () => {
  // getIntegrity (GAP-02) is deliberately excluded here: it is gated on the
  // separate systemLogs module (see its own describe block below), not
  // auditLog — auditLog is held by both system_admin and center_supervisor,
  // but the integrity/checkpoint-verify endpoint must be system-admin-only,
  // matching the plan's requirement and mirroring how systemLogs itself is
  // system_admin-exclusive in role-matrix.ts.
  const AUDIT_LOG_HANDLERS = HANDLERS.filter((n) => n !== 'getIntegrity');

  it('gates every non-integrity route on the auditLog module — none is unguarded', () => {
    for (const name of AUDIT_LOG_HANDLERS) {
      const required = routePermission(name);
      expect.soft(required, `${name} must declare a permission`).toBeDefined();
      expect.soft(required?.module, `${name} module`).toBe('auditLog');
    }
  });

  it.each([
    ['list', 'read'],
    ['getSummary', 'read'],
    ['getById', 'read'],
  ])('%s requires auditLog:%s', (handler, action) => {
    expect(routePermission(handler)).toEqual({ module: 'auditLog', action });
  });

  it('export is gated on `export`, not on `read`', () => {
    // The System Admin grant added for RIO-FR-007 turns on exactly this
    // action (see role-matrix.spec). If the route were gated on `read`, that
    // grant would be meaningless and every read-only role could download the
    // full log.
    expect(routePermission('export')).toEqual({ module: 'auditLog', action: 'export' });
    expect(routePath('export')).toBe('export');
  });

  it('the `export` action is not reused by any other route on this controller', () => {
    const exportRoutes = decoratedHandlers().filter((n) => routePermission(n)?.action === 'export');
    expect(exportRoutes).toEqual(['export']);
  });
});

describe('AuditController integrity endpoint gating (GAP-02)', () => {
  // System-admin-only: reuses the systemLogs module, which role-matrix.ts
  // grants to system_admin alone (see its own RIO-NFR-016 comment) — NOT
  // auditLog, which center_supervisor also holds. A checkpoint-integrity
  // check exposes whether the tamper-evidence chain itself is intact,
  // which is platform-operations territory, same posture as system_logs.
  it('GET /audit/integrity requires systemLogs:read', () => {
    expect(routePermission('getIntegrity')).toEqual({ module: 'systemLogs', action: 'read' });
    expect(routePath('getIntegrity')).toBe('integrity');
    expect(routeMethod('getIntegrity')).toBe(RequestMethod.GET);
  });

  it('is declared before the :id route so "integrity" can never be swallowed as an id', () => {
    // Same ordering hazard system-logs.controller.ts's request/:requestId
    // comment calls out — a literal path segment must be registered ahead
    // of the parameterised :id route it would otherwise be captured by.
    const names = Object.getOwnPropertyNames(AuditController.prototype).filter(
      (n) => n !== 'constructor' && routeMethod(n) !== undefined,
    );
    expect(names.indexOf('getIntegrity')).toBeLessThan(names.indexOf('getById'));
  });
});

describe('AuditController delegation', () => {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 }),
    exportCsv: vi.fn().mockResolvedValue('Timestamp,Actor\n'),
    getSummary: vi.fn().mockResolvedValue({}),
    getById: vi.fn().mockResolvedValue({}),
  };
  const checkpoints = {
    verify: vi.fn().mockResolvedValue({ ok: true }),
  };
  const controller = new AuditController(service as never, checkpoints as never);

  it('forwards every filter to the service, coercing empty strings to undefined', async () => {
    // An untouched filter input posts `?actorId=` — passing that through as
    // an empty string would match nothing instead of meaning "no filter".
    await controller.list('25', '50', 'o1', 'need', 'n1', '', 'approve', '2026-01-01', '2026-02-01', '', 'REF-1');

    expect(service.list).toHaveBeenCalledWith({
      limit: 25,
      offset: 50,
      organizationId: 'o1',
      entityType: 'need',
      entityId: 'n1',
      actorId: undefined,
      action: 'approve',
      dateFrom: '2026-01-01',
      dateTo: '2026-02-01',
      search: undefined,
      sourceRef: 'REF-1',
    });
  });

  it('sends the CSV back as a file download, not as an inline body', async () => {
    const headers: Record<string, string> = {};
    const res = { set: (h: Record<string, string>) => Object.assign(headers, h) };

    const csv = await controller.export(res as never, 'o1');

    expect(csv).toBe('Timestamp,Actor\n');
    expect(headers['Content-Type']).toBe('text/csv');
    expect(headers['Content-Disposition']).toMatch(
      /^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(service.exportCsv).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'o1' }));
  });

  it('getIntegrity returns the checkpoint verifier result as-is', async () => {
    checkpoints.verify.mockResolvedValueOnce({ ok: false, brokenCheckpointId: 'cp-1' });

    const result = await controller.getIntegrity();

    expect(checkpoints.verify).toHaveBeenCalledWith();
    expect(result).toEqual({ ok: false, brokenCheckpointId: 'cp-1' });
  });
});
