import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { stat, unlink } from 'node:fs/promises';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MailerService } from '../../mailer/mailer.service';
import { SystemLogsService } from '../system-logs/system-logs.service';
import { archiveAttachments, hashFile } from './attachment-archive.util';
import type { BackupDestination } from './backup-destination';
import { BACKUP_DESTINATION } from './backup-destination.token';
import { runPgDump } from './pg-dump.util';
import type { BackupKind, BackupResult, BackupTrigger } from './backup.types';

const CRON_JOB_NAME = 'database-backup';
const RETENTION_JOB_NAME = 'backup-retention';

/**
 * RIO-NFR-010 — periodic, recoverable backup of data and attachments.
 *
 * ─── What changed, and why ──────────────────────────────────────────────────
 * The first cut ran pg_dump on a cron and wrote a line to stdout. That is a
 * periodic backup but it is not an auditable one, and it is not a demonstrably
 * recoverable one: nothing recorded that a run happened, how big it was, or
 * whether the file still matches what was written. Both acceptance criteria
 * live in the gap between "the dump ran" and "we can prove the dump ran and is
 * intact".
 *
 * So every attempt now:
 *   1. writes a `backup_runs` row BEFORE doing any work, so a process killed
 *      mid-dump leaves a visible 'running' row rather than no trace,
 *   2. checksums the artefact it produced (SHA-256),
 *   3. stamps a retention date,
 *   4. and on failure writes a SystemLog at error level — a silent failed
 *      backup is the exact failure this ticket exists to prevent.
 *
 * ─── What is deliberately still open ────────────────────────────────────────
 * Destination and encryption are Q34: where dumps go (local disk today), which
 * key encrypts them, and who holds it. The seam for that is `backupDir`; the
 * values are the client's to give. Nothing here assumes local disk is the final
 * answer, and nothing has to change but the writer when it is not.
 */
@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly prisma: PrismaService,
    private readonly systemLog: SystemLogsService,
    private readonly mailer: MailerService,
    /**
     * Q34's seam. Local disk today, because that is the only destination the
     * client has given us; answering Q34 changes one line in BackupModule.
     *
     * Local disk is NOT a disaster-recovery destination — a backup on the
     * machine it protects survives a bad migration and nothing else. Stated
     * rather than assumed away.
     */
    @Inject(BACKUP_DESTINATION) private readonly destination: BackupDestination,
  ) {}

  // BACKUP_CRON_SCHEDULE is only known at runtime, so the jobs are registered
  // dynamically via SchedulerRegistry rather than a static @Cron(...)
  // decorator (whose expression must be a compile-time literal).
  onModuleInit(): void {
    const schedule = this.config.backupCronSchedule;
    const job = new CronJob(schedule, () => {
      void this.runScheduledBackup();
    });
    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
    job.start();

    // Retention runs on its own schedule, daily. Tying it to the backup tick
    // would mean a period with no backups is also a period with no pruning,
    // which is backwards: that is exactly when disk pressure builds.
    const sweep = new CronJob(this.config.backupRetentionCron, () => {
      void this.pruneExpired();
    });
    this.schedulerRegistry.addCronJob(RETENTION_JOB_NAME, sweep);
    sweep.start();

    this.logger.log(
      `Backups scheduled (cron: "${schedule}", retention: "${this.config.backupRetentionCron}", ` +
        `keep ${this.config.backupRetentionDays} days, destination: "${this.destination.name}", ` +
        `encrypted: ${this.destination.encrypts}, directory: "${this.config.backupDir}")`,
    );
  }

  /** The cron tick: both halves, so a restore always has a matching pair. */
  private async runScheduledBackup(): Promise<void> {
    await this.run('database', 'schedule');
    await this.run('attachments', 'schedule');
  }

  /**
   * One backup attempt. Never throws — a failed backup must not crash the app
   * or interrupt other scheduled work, and the failure is recorded in three
   * places instead: the run row, the system log, and the returned result.
   */
  async run(
    kind: BackupKind,
    trigger: BackupTrigger,
    triggeredBy?: string,
  ): Promise<BackupResult> {
    const startedAt = Date.now();
    const retainUntil = new Date(
      Date.now() + this.config.backupRetentionDays * 24 * 60 * 60 * 1000,
    );

    // Written first, on purpose. If the process dies mid-dump this row is the
    // only evidence the attempt happened at all.
    const run = await this.prisma.backupRun.create({
      data: {
        kind,
        status: 'running',
        trigger,
        triggeredBy: trigger === 'manual' ? (triggeredBy ?? null) : null,
        retainUntil,
      },
      select: { id: true },
    });

    try {
      const produced =
        kind === 'database'
          ? await this.dumpDatabase()
          : await this.dumpAttachments();

      // Hand the artefact to the destination, then checksum WHAT WAS STORED.
      // Hashing the plaintext and storing the ciphertext would give a checksum
      // that can never be verified against the file on disk, which defeats the
      // point of recording one.
      const stored = await this.destination.store(produced.filePath);
      const outcome = {
        ...produced,
        filePath: stored.location,
        sizeBytes: stored.sizeBytes,
        sha256: await hashFile(stored.location),
      };

      const durationMs = Date.now() - startedAt;
      await this.prisma.backupRun.update({
        where: { id: run.id },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          durationMs,
          fileName: outcome.fileName,
          filePath: outcome.filePath,
          sizeBytes: BigInt(outcome.sizeBytes),
          sha256: outcome.sha256,
          fileCount: outcome.fileCount ?? null,
        },
      });

      this.logger.log(
        `${kind} backup succeeded: ${outcome.fileName} (${outcome.sizeBytes} bytes, ${durationMs}ms)`,
      );
      return {
        success: true,
        runId: run.id,
        filePath: outcome.filePath,
        fileName: outcome.fileName,
        sizeBytes: outcome.sizeBytes,
        sha256: outcome.sha256,
        fileCount: outcome.fileCount,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      // Truncated here rather than by the column, so a long stack trace can
      // never be the reason the record of the failure fails to save.
      const stored = message.slice(0, 2000);

      await this.prisma.backupRun
        .update({
          where: { id: run.id },
          data: {
            status: 'failed',
            finishedAt: new Date(),
            durationMs,
            error: stored,
          },
        })
        .catch(() => undefined);

      this.logger.error(
        `${kind} backup failed after ${durationMs}ms: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
      // NFR-016's persisted telemetry. A backup that fails quietly is
      // indistinguishable from one that never ran, which is the whole risk.
      this.systemLog.record({
        level: 'error',
        category: 'job',
        source: 'BackupService',
        eventCode: 'BACKUP_FAILED',
        message: `${kind} backup failed: ${stored}`,
        error: err,
        context: { kind, trigger, runId: run.id, durationMs },
      });

      // The push half of the alert. backup_runs and SystemLog both record the
      // failure, but both are pull — somebody has to go and look. This is the
      // difference between finding out on Tuesday and finding out during a
      // restore. Best-effort: a mail failure must not add an exception on top
      // of a failure that is already recorded.
      await this.alertSystemAdmins(kind, stored, run.id, new Date(startedAt)).catch(
        () => undefined,
      );

      return { success: false, runId: run.id, durationMs, error: message };
    }
  }

  /**
   * Email every active System Admin that a backup failed.
   *
   * Recipients are resolved from the role rather than a configured address
   * list: an address list goes stale the moment someone leaves, and the people
   * who need to know are exactly the people who hold the permission to fix it.
   */
  private async alertSystemAdmins(
    kind: BackupKind,
    error: string,
    runId: string,
    startedAt: Date,
  ): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { roleId: 'role_system_admin', status: 'active' },
      select: { email: true },
    });
    const recipients = admins.map((u) => u.email).filter(Boolean);
    if (recipients.length === 0) {
      this.logger.warn(
        'A backup failed and no active System Admin exists to alert. The failure is recorded in backup_runs.',
      );
      return;
    }
    await this.mailer.sendBackupFailureAlert(recipients, { kind, error, runId, startedAt });
  }

  private async dumpDatabase(): Promise<{
    filePath: string;
    fileName: string;
    sizeBytes: number;
    sha256: string;
    fileCount?: number;
  }> {
    // BACKUP_DATABASE_URL, not DATABASE_URL. 43 tables FORCE row-level
    // security and every application role is NOBYPASSRLS, so pg_dump as
    // cnap_owner fails on the first of them rather than producing a partial
    // dump. scripts/sql/nfr010-backup-role.sql provisions the role that can.
    if (!this.config.backupDatabaseUrl) {
      throw new Error(
        'BACKUP_DATABASE_URL is not set. pg_dump cannot read this database as an ' +
          'application role because row-level security is FORCED on 43 tables. Run ' +
          'scripts/sql/nfr010-backup-role.sql as a superuser to create cnap_backup, ' +
          'then set BACKUP_DATABASE_URL to it.',
      );
    }

    // Must run BEFORE pg_dump, not after. With --enable-row-security a table
    // the backup role cannot read is dumped as empty rather than failing, so
    // this is the only thing standing between a schema change and a silently
    // unusable backup.
    await this.assertBackupRoleCoverage();

    const outcome = await runPgDump({
      databaseUrl: this.config.backupDatabaseUrl,
      backupDir: this.config.backupDir,
      pgDumpPath: this.config.pgDumpPath,
    });

    // A pg_dump that exits 0 having written nothing is not a success. Cheap to
    // check, and the alternative is discovering it during a restore.
    if (outcome.sizeBytes === 0) {
      throw new Error(`pg_dump produced an empty file: ${outcome.fileName}`);
    }
    return { ...outcome, sha256: await hashFile(outcome.filePath) };
  }

  /**
   * Every RLS-enabled table must carry a read policy for the backup role.
   *
   * A table added by a later migration with row-level security and no
   * cnap_backup policy would be dumped as EMPTY under --enable-row-security:
   * pg_dump would succeed, the checksum would match, the run would be recorded
   * green, and the missing rows would only surface during a restore. That is
   * the worst failure this module could produce, so the run is refused instead.
   *
   * Cheap: one catalogue query per database backup, no rows scanned.
   */
  private async assertBackupRoleCoverage(): Promise<void> {
    const uncovered = await this.prisma.$queryRaw<{ relname: string }[]>`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relrowsecurity
         AND NOT EXISTS (
           SELECT 1 FROM pg_policies pp
            WHERE pp.schemaname = 'public'
              AND pp.tablename = c.relname
              AND 'cnap_backup' = ANY (pp.roles)
         )
       ORDER BY c.relname
    `;

    if (uncovered.length > 0) {
      const names = uncovered.map((row) => row.relname).join(', ');
      throw new Error(
        `${uncovered.length} table(s) enforce row-level security with no cnap_backup read ` +
          `policy, so a dump would silently omit their rows: ${names}. ` +
          `Add a policy for each (see migration 20260904040000) before backing up.`,
      );
    }
  }

  private async dumpAttachments(): Promise<{
    filePath: string;
    fileName: string;
    sizeBytes: number;
    sha256: string;
    fileCount: number;
  }> {
    const outcome = await archiveAttachments({
      storagePath: this.config.evidenceStoragePath,
      backupDir: this.config.backupDir,
    });
    return {
      filePath: outcome.filePath,
      fileName: outcome.fileName,
      sizeBytes: outcome.sizeBytes,
      sha256: outcome.sha256,
      fileCount: outcome.fileCount,
    };
  }

  /**
   * Verify a stored artefact still matches the checksum recorded when it was
   * written. This is what turns "a backup exists" into "a backup is intact",
   * and it is the half of AC 1 that a schedule alone does not give you.
   */
  async verify(runId: string): Promise<{ ok: boolean; reason: string | null }> {
    const run = await this.prisma.backupRun.findUnique({ where: { id: runId } });
    if (!run) return { ok: false, reason: 'RUN_NOT_FOUND' };
    if (run.status !== 'succeeded') return { ok: false, reason: 'RUN_DID_NOT_SUCCEED' };
    if (run.prunedAt) return { ok: false, reason: 'FILE_PRUNED' };
    if (!run.filePath || !run.sha256) return { ok: false, reason: 'NO_ARTEFACT_RECORDED' };

    try {
      const stats = await stat(run.filePath);
      if (BigInt(stats.size) !== (run.sizeBytes ?? BigInt(-1))) {
        return { ok: false, reason: 'SIZE_CHANGED' };
      }
      const actual = await hashFile(run.filePath);
      return actual === run.sha256
        ? { ok: true, reason: null }
        : { ok: false, reason: 'CHECKSUM_MISMATCH' };
    } catch {
      return { ok: false, reason: 'FILE_MISSING' };
    }
  }

  /**
   * Delete files past their retention date.
   *
   * Two rules that are not negotiable:
   *   - the newest SUCCESSFUL run of each kind is never deleted, whatever
   *     retention says. A retention policy that can leave you with no backup
   *     at all is not a retention policy, it is a deletion policy.
   *   - the row survives; only the file goes, and `pruned_at` records when.
   *     Deleting the row would leave a hole exactly where an auditor looks.
   */
  async pruneExpired(): Promise<{ pruned: number; keptNewest: number }> {
    const newest = await Promise.all(
      (['database', 'attachments'] as const).map((kind) =>
        this.prisma.backupRun.findFirst({
          where: { kind, status: 'succeeded', prunedAt: null },
          orderBy: { startedAt: 'desc' },
          select: { id: true },
        }),
      ),
    );
    const protectedIds = newest.filter((r) => r !== null).map((r) => r.id);

    const expired = await this.prisma.backupRun.findMany({
      where: {
        prunedAt: null,
        retainUntil: { lt: new Date() },
        id: { notIn: protectedIds.length > 0 ? protectedIds : ['00000000-0000-0000-0000-000000000000'] },
      },
      select: { id: true, filePath: true, fileName: true },
    });

    let pruned = 0;
    for (const run of expired) {
      if (run.filePath) {
        // A file already gone is not an error — the point of the sweep is that
        // it is no longer there.
        await unlink(run.filePath).catch(() => undefined);
        await unlink(`${run.filePath}.manifest.json`).catch(() => undefined);
      }
      await this.prisma.backupRun.update({
        where: { id: run.id },
        data: { prunedAt: new Date() },
      });
      pruned++;
    }

    if (pruned > 0) {
      this.logger.log(
        `Backup retention: pruned ${pruned} run(s), kept ${protectedIds.length} newest successful.`,
      );
    }
    return { pruned, keptNewest: protectedIds.length };
  }
}
