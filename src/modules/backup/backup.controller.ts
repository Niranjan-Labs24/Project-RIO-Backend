import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { requireActor } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { SystemLogsService } from '../system-logs/system-logs.service';
import { BackupService } from './backup.service';
import {
  ListBackupRunsQuery,
  TriggerBackupBody,
  type ListBackupRunsQueryDto,
  type TriggerBackupDto,
} from './backup.contract';
import { PrismaService } from '../../prisma/prisma.service';
import type { BackupRunView, BackupSummary, RecoverabilityCheck } from './backup.types';

/**
 * RIO-NFR-010 — the administrator's view of backups.
 *
 * Gated on `backups`, its own permission module. NOT `systemLogs`: that module
 * is read-and-export by design and carries no write grant for anyone, because
 * nobody writes an operational log through an API — see 20260904010000.
 *
 * There is no org scoping here because there is nothing to scope. A dump
 * contains every entity's rows, so it belongs to none of them; this is platform
 * infrastructure, not tenant data.
 */
@Controller('backups')
export class BackupController {
  constructor(
    private readonly backups: BackupService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    /**
     * Not for recording — BackupService already does that. This is here to
     * FLUSH: see the note on each endpoint below.
     */
    private readonly systemLog: SystemLogsService,
  ) {}

  /** AC 2 — the auditable log, as a queryable list rather than a text file. */
  @Get()
  @RequirePermission('backups', 'read')
  async list(
    @Query(new TypeBoxValidationPipe(ListBackupRunsQuery)) query: ListBackupRunsQueryDto,
  ): Promise<{ items: BackupRunView[]; total: number }> {
    const page = query.page ? Number(query.page) : 1;
    const pageSize = query.pageSize ? Number(query.pageSize) : 25;
    const where = {
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.backupRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.backupRun.count({ where }),
    ]);

    return { items: rows.map(toView), total };
  }

  /**
   * The figure an administrator opens this screen to check: when did a backup
   * last actually succeed. Not "when did one last run" — a run that failed is
   * worse than no run, because it looks like coverage.
   */
  @Get('summary')
  @RequirePermission('backups', 'read')
  async summary(): Promise<BackupSummary> {
    const [database, attachments, failures, sizes] = await Promise.all([
      this.prisma.backupRun.findFirst({
        where: { kind: 'database', status: 'succeeded' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
      this.prisma.backupRun.findFirst({
        where: { kind: 'attachments', status: 'succeeded' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
      this.prisma.backupRun.count({
        where: {
          status: 'failed',
          startedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      }),
      this.prisma.backupRun.aggregate({
        where: { status: 'succeeded', prunedAt: null },
        _sum: { sizeBytes: true },
      }),
    ]);

    return {
      lastSuccessfulDatabase: database?.startedAt ?? null,
      lastSuccessfulAttachments: attachments?.startedAt ?? null,
      failuresLast7Days: failures,
      totalSizeBytes: Number(sizes._sum.sizeBytes ?? 0n),
    };
  }

  /**
   * Run a backup now.
   *
   * `write` rather than `read`: it consumes disk and CPU on a live system. It
   * is also audited as a human act — the run row records the machine event,
   * AuditLog records that a named person asked for it.
   */
  @Post('run')
  @RequirePermission('backups', 'write')
  async trigger(
    @Body(new TypeBoxValidationPipe(TriggerBackupBody)) body: TriggerBackupDto,
  ): Promise<{ runId: string | undefined; success: boolean; error?: string }> {
    const actor = requireActor();
    const result = await this.backups.run(body.kind, 'manual', actor);

    await this.audit.record({
      action: 'run_backup',
      entityType: 'backup_run',
      entityId: result.runId ?? null,
      entityLabel: `Manual ${body.kind} backup`,
      // Platform-level: a backup spans every entity, so filing it under the
      // administrator's own organisation would misattribute it.
      organizationId: null,
      changes: [
        { field: 'Kind', before: null, after: body.kind },
        { field: 'Outcome', before: null, after: result.success ? 'succeeded' : 'failed' },
        { field: 'Size', before: null, after: result.sizeBytes ?? null },
        { field: 'Error', before: null, after: result.error ?? null },
      ],
    });

    // SystemLogsService buffers and flushes on a 2s timer, which is right for
    // the thousands of events a request pipeline produces and wrong for this
    // one: the caller is a screen that reloads the log table the moment this
    // response lands, and a BACKUP_SUCCEEDED row still sitting in a buffer
    // reads to the operator as a backup that was never logged. Forcing the
    // flush makes the response mean "the record exists", which is what the
    // person who clicked the button is actually waiting to be told.
    //
    // Cheap, and only on this path: one batched insert of a couple of rows,
    // on an action a human takes by hand.
    await this.systemLog.flush();

    return { runId: result.runId, success: result.success, error: result.error };
  }

  /**
   * Re-checksum a stored artefact.
   *
   * This is the half of "recoverable" that a schedule does not give you: a
   * dump that no longer matches the checksum written with it is corrupt, and a
   * disaster is the wrong time to discover that.
   */
  @Post(':runId/verify')
  @RequirePermission('backups', 'read')
  verify(
    @Param('runId', new UuidParamPipe()) runId: string,
  ): Promise<{ ok: boolean; reason: string | null }> {
    return this.backups.verify(runId);
  }

  /**
   * The deeper question: is this backup RECOVERABLE.
   *
   * `verify` re-checksums; this opens the artefact and checks it parses as
   * something a restore could consume — `pg_restore --list` for a dump, the
   * embedded manifest for an attachment archive. Still a read: it writes
   * nothing, restores nothing and never touches the live database, so it is
   * gated on `read` like verify rather than `write`.
   *
   * It is NOT a restore rehearsal. That needs a scratch database and lives in
   * `pnpm nfr010:restore-check`; the response says which check ran so the two
   * are never confused.
   */
  @Post(':runId/recoverability')
  @RequirePermission('backups', 'read')
  async checkRecoverability(
    @Param('runId', new UuidParamPipe()) runId: string,
  ): Promise<RecoverabilityCheck> {
    const result = await this.backups.checkRecoverability(runId);
    // Same reason as the run endpoint: BACKUP_RECOVERABLE / _NOT_RECOVERABLE
    // is the evidence the check happened, and it is worth nothing to an
    // operator who reloads the page before it is written.
    await this.systemLog.flush();
    return result;
  }

  /** Run the retention sweep now. Audited: it deletes files. */
  @Post('prune')
  @RequirePermission('backups', 'write')
  async prune(): Promise<{ pruned: number; keptNewest: number }> {
    const result = await this.backups.pruneExpired();
    await this.audit.record({
      action: 'prune_backups',
      entityType: 'backup_run',
      entityId: null,
      entityLabel: 'Backup retention sweep',
      organizationId: null,
      changes: [
        { field: 'Pruned', before: null, after: result.pruned },
        { field: 'Newest kept', before: null, after: result.keptNewest },
      ],
    });
    return result;
  }
}

function toView(row: {
  id: string;
  kind: string;
  status: string;
  trigger: string;
  triggeredBy: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  fileName: string | null;
  sizeBytes: bigint | null;
  sha256: string | null;
  fileCount: number | null;
  retainUntil: Date | null;
  prunedAt: Date | null;
  error: string | null;
}): BackupRunView {
  return {
    id: row.id,
    kind: row.kind as BackupRunView['kind'],
    status: row.status as BackupRunView['status'],
    trigger: row.trigger as BackupRunView['trigger'],
    triggeredBy: row.triggeredBy,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    fileName: row.fileName,
    // BigInt does not survive JSON.stringify. Sizes here are file sizes, well
    // inside Number's safe range, so the conversion is lossless in practice.
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    sha256: row.sha256,
    fileCount: row.fileCount,
    retainUntil: row.retainUntil,
    prunedAt: row.prunedAt,
    error: row.error,
  };
}
