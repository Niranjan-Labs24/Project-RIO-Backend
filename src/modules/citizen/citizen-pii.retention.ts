import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '../../config/config.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';

const CRON_JOB_NAME = 'citizen-pii-retention';
const OTP_TTL_HOURS = 24;

/**
 * RIO-NFR-002 — citizen PII retention.
 *
 * 1. CitizenOtpChallenge rows: deleted after 24 h (OTPs are single-use and
 *    short-lived by design; retaining them past one day is unnecessary and
 *    increases PII exposure surface).
 *
 * 2. SurveyResponse.contact / .mobile: nullified after
 *    CITIZEN_PII_RETENTION_DAYS (default 90). The response row itself and
 *    its answers/scores are kept for analytical reporting; only the
 *    identifying contact details are removed once the dedup window passes.
 */
@Injectable()
export class CitizenPiiRetentionService implements OnModuleInit {
  private readonly logger = new Logger(CitizenPiiRetentionService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly tenant: TenantPrismaService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const schedule = this.config.citizenPiiRetentionCron;
    const job = new CronJob(schedule, () => {
      void this.purge();
    });
    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
    job.start();
    this.logger.log(
      `Citizen PII retention scheduled (cron: "${schedule}", ` +
      `response PII retained for ${this.config.citizenPiiRetentionDays} days)`,
    );
  }

  /** Never throws — a failed purge must not crash the app. */
  async purge(): Promise<void> {
    try {
      const otpCutoff = new Date(Date.now() - OTP_TTL_HOURS * 3_600_000);
      const responseCutoff = new Date(
        Date.now() - this.config.citizenPiiRetentionDays * 86_400_000,
      );

      // 1. Delete expired OTP challenges (ephemeral, no audit value retained)
      const { count: otpDeleted } = await this.tenant.runAsSupervisor((tx) =>
        tx.citizenOtpChallenge.deleteMany({
          where: { createdAt: { lt: otpCutoff } },
        }),
      );

      // 2. Nullify contact/mobile on old SurveyResponse rows.
      //    Uses runAsSupervisor (cross-org) since retention is a platform-wide
      //    operation, not scoped to a single organisation.
      const { count: responsesNullified } = await this.tenant.runAsSupervisor((tx) =>
        tx.surveyResponse.updateMany({
          where: {
            submittedAt: { lt: responseCutoff },
            OR: [{ contact: { not: '' } }, { mobile: { not: null } }],
          },
          data: { contact: '', mobile: null },
        }),
      );

      this.logger.log(
        `Citizen PII retention: deleted ${otpDeleted} OTP challenges, ` +
        `nullified PII on ${responsesNullified} survey responses`,
      );
    } catch (err) {
      this.logger.error(
        'Citizen PII retention purge failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
