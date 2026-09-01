import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '../../config/config.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { EvidenceStorageService } from './evidence.storage.service';

const CRON_JOB_NAME = 'evidence-file-cleanup';

/**
 * GAP-13 — durable retry for evidence files whose physical delete failed.
 *
 * EvidenceService.remove deletes the DB row first; if the follow-up
 * EvidenceStorageService.remove() (fs unlink) then fails, it used to be
 * silently swallowed, orphaning the file on disk with nothing to signal it.
 * The DB row is now durably recorded in PendingFileDeletion (a global table,
 * no orgId/RLS — see that model's migration) instead, and this cron sweep
 * retries the unlink: deletes the row on success, or increments
 * attempts/records lastError and leaves the row for the next sweep on
 * failure.
 */
@Injectable()
export class EvidenceFileCleanupService implements OnModuleInit {
  private readonly logger = new Logger(EvidenceFileCleanupService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly tenant: TenantPrismaService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly storage: EvidenceStorageService,
  ) {}

  onModuleInit(): void {
    const schedule = this.config.evidenceCleanupCron;
    const job = new CronJob(schedule, () => {
      void this.sweep();
    });
    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
    job.start();
    this.logger.log(`Evidence file cleanup scheduled (cron: "${schedule}")`);
  }

  /** Never throws — a failed sweep must not crash the process. */
  async sweep(): Promise<void> {
    try {
      // PendingFileDeletion has no org scoping (the owning Evidence row is
      // already gone by the time a row is written here), so this runs
      // cross-org with no org GUC set — safe because the table has no RLS
      // policy to bypass. Same pattern as SystemLogsService.purgeBatch.
      const pending = await this.tenant.runAsSupervisorWrite((tx) => tx.pendingFileDeletion.findMany());

      let cleared = 0;
      let stillFailing = 0;
      for (const row of pending) {
        // GAP-13 review follow-up: storage.remove() now resolves the real
        // caught error (message + OS error code) instead of a bare
        // boolean — that real error is persisted as lastError, replacing
        // the old generic "Retry failed at <timestamp>" placeholder.
        const removeError = await this.storage.remove(row.storageKey);
        if (!removeError) {
          await this.tenant.runAsSupervisorWrite((tx) => tx.pendingFileDeletion.delete({ where: { id: row.id } }));
          cleared += 1;
        } else {
          await this.tenant.runAsSupervisorWrite((tx) =>
            tx.pendingFileDeletion.update({
              where: { id: row.id },
              data: {
                attempts: row.attempts + 1,
                lastError: `${removeError.code ?? 'ERR'}: ${removeError.message}`,
              },
            }),
          );
          stillFailing += 1;
        }
      }

      if (pending.length > 0) {
        this.logger.log(
          `Evidence file cleanup sweep: cleared ${cleared}, still failing ${stillFailing} (of ${pending.length} pending)`,
        );
      }
    } catch (err) {
      this.logger.error(
        'Evidence file cleanup sweep failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
