import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '../../config/config.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { MailerService } from '../../mailer/mailer.service';
import { SmsService } from '../../sms/sms.service';
import { SurveySessionsService } from './survey-sessions.service';
import type { SweepResult } from './survey-sessions.types';

const CRON_JOB_NAME = 'survey-session-sweep';
/** Backstop: one pass never sends more than this, whatever the backlog says.
 *  A mis-set threshold on a large study must not turn into a mass send. */
const MAX_SENDS_PER_PASS = 200;

/**
 * Completion reminders — the third part of the client answer of 24 Aug:
 * "Also, study if we can remind them to complete the survey."
 *
 * We can, within these limits, and this is the mechanism:
 *
 *   • ONLY a session that reached the contact step has anywhere to send to.
 *     A respondent who opened the link and left before entering an email or
 *     mobile is unreachable by construction — they are counted in the
 *     abandonment rate and nothing more. In practice that caps how much of
 *     the drop-off a reminder can ever recover.
 *   • Reminders go out BEFORE the abandonment threshold (default 30 min idle
 *     vs 120 min abandoned), because the goal is to recover the response
 *     while the link is still open on the phone, not to chase a lost one.
 *   • Capped (SURVEY_REMINDER_MAX, default 2) with a cooldown between sends,
 *     so a respondent who stopped on purpose is not harassed.
 *   • OFF by default (SURVEY_REMINDERS_ENABLED=false). This is outbound
 *     contact with a citizen; it starts when the client says the wording and
 *     cadence are right, not when a build ships.
 *   • The reminder repeats the link and nothing else. It cannot restore what
 *     was typed — no partial answers are stored (client answer, point 1) —
 *     so it must not promise "continue where you left off". The respondent
 *     re-enters their answers, and the message says so.
 *
 * Both channels soft-fail exactly like the OTP send: a provider outage is a
 * missed nudge, never a crashed sweep.
 */
@Injectable()
export class SurveyReminderService implements OnModuleInit {
  private readonly logger = new Logger(SurveyReminderService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly tenant: TenantPrismaService,
    private readonly sessions: SurveySessionsService,
    private readonly mailer: MailerService,
    private readonly sms: SmsService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  // Registered dynamically (same reason as BackupService / the system-log
  // retention job): the schedule is a runtime config value, and @Cron(...)
  // needs a compile-time literal.
  onModuleInit(): void {
    const schedule = this.config.surveySessionSweepCron;
    const job = new CronJob(schedule, () => {
      void this.sweep();
    });
    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
    job.start();
    this.logger.log(
      `Survey session sweep scheduled (cron: "${schedule}", abandoned after ` +
        `${this.config.surveyAbandonmentIdleMinutes}m idle, reminders ` +
        `${this.config.surveyRemindersEnabled ? 'ENABLED' : 'disabled'})`,
    );
  }

  /**
   * One pass: send any due reminders, then mark the genuinely stale sessions
   * abandoned. That order matters — reminding first gives a session its last
   * chance before it is written off, and the abandonment sweep then closes
   * the ones that did not come back.
   *
   * Never throws.
   */
  async sweep(now = new Date()): Promise<SweepResult> {
    let reminders = { sent: 0, skipped: 0 };
    try {
      reminders = await this.sendDueReminders(now);
    } catch (err) {
      this.logger.error(`Survey reminder pass failed: ${(err as Error).message}`);
    }
    let abandonedMarked = 0;
    try {
      abandonedMarked = await this.sessions.sweepAbandoned(now);
    } catch (err) {
      this.logger.error(`Survey abandonment sweep failed: ${(err as Error).message}`);
    }
    if (abandonedMarked || reminders.sent) {
      this.logger.log(
        `Survey session sweep: ${abandonedMarked} marked abandoned, ${reminders.sent} reminder(s) sent`,
      );
    }
    return { abandonedMarked, remindersSent: reminders.sent, remindersSkipped: reminders.skipped };
  }

  private async sendDueReminders(now: Date): Promise<{ sent: number; skipped: number }> {
    if (!this.config.surveyRemindersEnabled) return { sent: 0, skipped: 0 };

    const idleCutoff = new Date(now.getTime() - this.config.surveyReminderIdleMinutes * 60_000);
    const cooldownCutoff = new Date(now.getTime() - this.config.surveyReminderCooldownMinutes * 60_000);
    // Past the abandonment threshold there is nothing left to recover — the
    // session is already counted as an invalid response in RPT10, and a
    // message at that point is just noise to the respondent.
    const abandonedCutoff = new Date(now.getTime() - this.config.surveyAbandonmentIdleMinutes * 60_000);

    const due = await this.tenant.runAsSupervisor((tx) =>
      tx.surveySession.findMany({
        where: {
          submittedAt: null,
          status: { notIn: ['SUBMITTED', 'ABANDONED'] },
          lastEventAt: { lt: idleCutoff, gte: abandonedCutoff },
          remindersSent: { lt: this.config.surveyReminderMax },
          OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: cooldownCutoff } }],
          // No contact channel → unreachable. Not an error, just outside what
          // a reminder can do.
          NOT: [{ contact: null, mobile: null }],
          // A revoked or expired link must never be re-advertised.
          surveyLink: { isActive: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        },
        take: MAX_SENDS_PER_PASS,
        orderBy: { lastEventAt: 'asc' },
        select: {
          id: true,
          orgId: true,
          contact: true,
          mobile: true,
          answeredCount: true,
          questionCount: true,
          surveyLink: { select: { token: true, label: true, need: { select: { title: true } } } },
        },
      }),
    );

    let sent = 0;
    let skipped = 0;
    for (const session of due) {
      const url = `${this.config.publicAppUrl}/public/survey/${session.surveyLink.token}`;
      const needTitle = session.surveyLink.need?.title ?? session.surveyLink.label;
      const delivered = await this.deliver(session, url, needTitle);
      if (!delivered) {
        skipped += 1;
        continue;
      }
      // Counted only on a delivery that actually went out, so a provider
      // outage does not silently burn a respondent two allowed reminders.
      // `lastEventAt` is deliberately NOT touched: a reminder is our activity,
      // not the respondent, and bumping it would postpone the abandonment
      // classification for a session nobody came back to.
      try {
        await this.tenant.runAsOrg(session.orgId, (tx) =>
          tx.surveySession.updateMany({
            where: { id: session.id, submittedAt: null },
            data: { remindersSent: { increment: 1 }, lastReminderAt: now },
          }),
        );
        sent += 1;
      } catch (err) {
        this.logger.warn(`Reminder sent but not recorded for session ${session.id}: ${(err as Error).message}`);
      }
    }
    return { sent, skipped };
  }

  /** Email first, SMS as the fallback — one nudge per pass, never both, so a
   *  respondent with two channels is not messaged twice for one reminder. */
  private async deliver(
    session: { contact: string | null; mobile: string | null; answeredCount: number; questionCount: number },
    url: string,
    needTitle: string,
  ): Promise<boolean> {
    if (session.contact) {
      const ok = await this.mailer.sendSurveyReminder(session.contact, { needTitle, publicUrl: url });
      if (ok) return true;
    }
    if (session.mobile) {
      return this.sms.sendSurveyReminder(session.mobile, url);
    }
    return false;
  }
}
