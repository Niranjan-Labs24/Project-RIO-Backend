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

      // Retention writes are per-organisation, not cross-org. The citizen
      // tables enforce RLS on org_id, and the only runtime path that both
      // satisfies that policy and holds write grants is cnap_app with the org
      // GUC set (runAsOrg). The cross-org cnap_supervisor connection is
      // SELECT-only, and the GUC-less cnap_app path (runAsSupervisorWrite) is
      // fail-closed by RLS — either one would touch zero rows (or be denied
      // outright). Enumerate orgs via the supervisor read, then purge each
      // under its own context.
      const orgs = await this.tenant.runAsSupervisor((tx) =>
        tx.organisation.findMany({ select: { id: true } }),
      );

      let otpDeleted = 0;
      let responsesRedacted = 0;
      for (const { id: orgId } of orgs) {
        await this.tenant.runAsOrg(orgId, async (tx) => {
          // 1. Delete expired OTP challenges — ephemeral verification tokens
          //    (cnap_app holds DELETE on this table alone; see
          //    20260821000000_citizen_otp_retention_delete_grant).
          const { count } = await tx.citizenOtpChallenge.deleteMany({
            where: { createdAt: { lt: otpCutoff } },
          });
          otpDeleted += count;

          // 2. Scrub contact/mobile on old SurveyResponse rows. A raw UPDATE,
          //    not updateMany: `contact` is non-nullable and carries a
          //    @@unique([needId, contact]) constraint, so blanking every aged
          //    row to one shared value would collide the moment a single Need
          //    has two aged responses. Redacting to a per-row-unique
          //    "redacted:<id>" token removes the PII while keeping the value
          //    unique; decryptPii() passes the token through unchanged (it is
          //    not ciphertext). The response row and its answers/scores are
          //    kept for analytical reporting — only the identifiers go.
          responsesRedacted += await tx.$executeRaw`
            UPDATE "survey_responses"
            SET "contact" = 'redacted:' || "id"::text, "mobile" = NULL
            WHERE "submitted_at" < ${responseCutoff}
              AND "contact" NOT LIKE 'redacted:%'
          `;
        });
      }

      this.logger.log(
        `Citizen PII retention: deleted ${otpDeleted} OTP challenges, ` +
        `redacted PII on ${responsesRedacted} survey responses ` +
        `across ${orgs.length} organisations`,
      );
    } catch (err) {
      this.logger.error(
        'Citizen PII retention purge failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
