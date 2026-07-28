import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '../../config/config.service';
import { runPgDump } from './pg-dump.util';
import type { BackupResult } from './backup.types';

const CRON_JOB_NAME = 'database-backup';

@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  // BACKUP_CRON_SCHEDULE is only known at runtime, so the job is registered
  // dynamically via SchedulerRegistry rather than a static @Cron(...)
  // decorator (whose expression must be a compile-time literal).
  onModuleInit(): void {
    const schedule = this.config.backupCronSchedule;
    const job = new CronJob(schedule, () => {
      void this.runBackup();
    });
    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
    job.start();
    this.logger.log(
      `Database backup scheduled (cron: "${schedule}", directory: "${this.config.backupDir}")`,
    );
  }

  // Never throws — a failed backup must never crash the app or interrupt
  // any other request-handling/scheduled work. Public (not just called from
  // the cron tick) so a manual/ops trigger can reuse it later if needed.
  async runBackup(): Promise<BackupResult> {
    const startedAt = Date.now();
    try {
      const outcome = await runPgDump({
        databaseUrl: this.config.databaseUrl,
        backupDir: this.config.backupDir,
        pgDumpPath: this.config.pgDumpPath,
      });
      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `Database backup succeeded: ${outcome.fileName} (${outcome.sizeBytes} bytes, ${durationMs}ms) -> ${outcome.filePath}`,
      );
      return {
        success: true,
        filePath: outcome.filePath,
        fileName: outcome.fileName,
        sizeBytes: outcome.sizeBytes,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Database backup failed after ${durationMs}ms: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
      return { success: false, durationMs, error: message };
    }
  }
}
