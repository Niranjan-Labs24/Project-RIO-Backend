import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '../../config/config.service';
import { SystemLogsService } from './system-logs.service';

const CRON_JOB_NAME = 'system-log-retention';
const CHUNK_SIZE = 10_000;
/** Backstop against an unbounded loop if a purge somehow never drains. */
const MAX_CHUNKS = 100;

/**
 * RIO-NFR-016 retention. The operational log is diagnostic telemetry with a
 * finite useful life — the opposite of audit_logs (RIO-FR-007), whose own
 * acceptance criterion is that it can never be deleted. That difference is
 * exactly why the two live in separate tables.
 *
 * Deletes in bounded chunks: one unbounded DELETE on a hot append-only
 * table is a lock hazard.
 */
@Injectable()
export class SystemLogsRetentionService implements OnModuleInit {
  private readonly logger = new Logger(SystemLogsRetentionService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly logs: SystemLogsService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  // Registered dynamically (same reason as BackupService): the schedule is a
  // runtime config value, and @Cron(...) needs a compile-time literal.
  onModuleInit(): void {
    const schedule = this.config.systemLogRetentionCron;
    const job = new CronJob(schedule, () => {
      void this.purge();
    });
    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
    job.start();
    this.logger.log(
      `System log retention scheduled (cron: "${schedule}", keeping ${this.config.systemLogRetentionDays} days)`,
    );
  }

  /** Never throws — a failed purge must not crash the app. */
  async purge(): Promise<number> {
    const days = this.config.systemLogRetentionDays;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    let deleted = 0;
    try {
      for (let i = 0; i < MAX_CHUNKS; i++) {
        const n = await this.logs.purgeBatch(cutoff, CHUNK_SIZE);
        deleted += n;
        if (n < CHUNK_SIZE) break;
      }
      this.logger.log(`Purged ${deleted} system log entries older than ${cutoff.toISOString()}`);
      // The purge logs its own outcome into the very table it prunes — a
      // retention job that runs silently is one you find out has been broken
      // for six months.
      this.logs.record({
        level: 'info',
        category: 'job',
        source: SystemLogsRetentionService.name,
        eventCode: 'SYSTEM_LOG_PURGE',
        message: `Purged ${deleted} system log entries older than ${cutoff.toISOString()}`,
        context: { deleted, retentionDays: days, cutoff: cutoff.toISOString() },
      });
      return deleted;
    } catch (err) {
      this.logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      this.logs.record({
        level: 'error',
        category: 'job',
        source: SystemLogsRetentionService.name,
        eventCode: 'SYSTEM_LOG_PURGE_FAILED',
        message: 'System log retention purge failed',
        error: err,
        context: { deleted, retentionDays: days },
      });
      return deleted;
    }
  }
}
