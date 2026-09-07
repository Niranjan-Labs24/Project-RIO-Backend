import { describe, expect, it, vi } from 'vitest';
import { PERMISSION_KEY } from '../../common/guards/permission.guard';
import { BackupController } from './backup.controller';
import type { BackupService } from './backup.service';
import type { AuditService } from '../audit/audit.service';
import type { SystemLogsService } from '../system-logs/system-logs.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * RIO-NFR-010 — the two things about this controller that are easy to break
 * silently.
 *
 * 1. **The log rows exist by the time the response does.** SystemLogsService
 *    buffers on a 2s timer, and the caller is a screen that reloads the log
 *    table the instant this returns. A BACKUP_SUCCEEDED row still sitting in
 *    a buffer reads to the operator as a backup that was never logged, which
 *    is precisely the doubt AC 2 exists to remove.
 * 2. **Running a backup needs `write`; asking about one needs `read`.** A run
 *    consumes disk and CPU on a live system. Verification and the
 *    recoverability check write nothing at all.
 */

vi.mock('../../tenancy/org-context', () => ({
  requireActor: () => 'user-1',
}));

function build(overrides: { runSucceeds?: boolean; recoverable?: boolean } = {}) {
  const backups = {
    run: vi.fn(async () => ({
      success: overrides.runSucceeds ?? true,
      runId: 'run-1',
      durationMs: 10,
      sizeBytes: 4096,
    })),
    checkRecoverability: vi.fn(async () => ({
      ok: overrides.recoverable ?? true,
      checksumOk: true,
      reason: null,
      checkedAt: new Date(),
      durationMs: 5,
      detail: { tableDataEntries: 83 },
    })),
  } as unknown as BackupService;
  const systemLog = { flush: vi.fn(async () => undefined) } as unknown as SystemLogsService;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const controller = new BackupController(backups, {} as PrismaService, audit, systemLog);
  return { controller, backups, systemLog, audit };
}

function permissionOf(name: string): { module: string; action: string } | undefined {
  const handler = (BackupController.prototype as unknown as Record<string, unknown>)[
    name
  ] as object;
  return Reflect.getMetadata(PERMISSION_KEY, handler) as
    | { module: string; action: string }
    | undefined;
}

describe('BackupController', () => {
  it('flushes the system log before answering a triggered run', async () => {
    const { controller, systemLog } = build();

    await controller.trigger({ kind: 'database' });

    expect(systemLog.flush).toHaveBeenCalledOnce();
  });

  it('flushes on a FAILED run too — the failure is the row that matters most', async () => {
    const { controller, systemLog } = build({ runSucceeds: false });

    await controller.trigger({ kind: 'database' });

    expect(systemLog.flush).toHaveBeenCalledOnce();
  });

  it('flushes after a recoverability check, and returns its result unchanged', async () => {
    const { controller, systemLog } = build();

    const result = await controller.checkRecoverability('11111111-1111-1111-1111-111111111111');

    expect(result.ok).toBe(true);
    expect(result.detail.tableDataEntries).toBe(83);
    expect(systemLog.flush).toHaveBeenCalledOnce();
  });

  it('gates a run on write and the read-only checks on read', () => {
    expect(permissionOf('trigger')).toEqual({ module: 'backups', action: 'write' });
    expect(permissionOf('prune')).toEqual({ module: 'backups', action: 'write' });
    // Neither of these writes anything, restores anything, or touches the live
    // database — so requiring `write` would only mean fewer people can check
    // whether the backups are any good.
    expect(permissionOf('verify')).toEqual({ module: 'backups', action: 'read' });
    expect(permissionOf('checkRecoverability')).toEqual({ module: 'backups', action: 'read' });
  });
});
