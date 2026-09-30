import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SurveyReminderService } from './survey-reminder.service';
import type { ConfigService } from '../../config/config.service';
import type { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import type { SurveySessionsService } from './survey-sessions.service';
import type { MailerService } from '../../mailer/mailer.service';
import type { SmsService } from '../../sms/sms.service';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { TranslationService } from '../translation/translation.service';

type Session = {
  id: string;
  orgId: string;
  contact: string | null;
  mobile: string | null;
  answeredCount: number;
  questionCount: number;
  surveyLink: { token: string; label: string; need: { title: string } | null };
};

function session(over: Partial<Session> = {}): Session {
  return {
    id: 'ss1',
    orgId: 'o1',
    contact: 'citizen@example.test',
    mobile: null,
    answeredCount: 2,
    questionCount: 5,
    surveyLink: { token: 'tok1', label: 'Wave 1', need: { title: 'Water access' } },
    ...over,
  };
}

function build(opts: {
  enabled?: boolean;
  due?: Session[];
  mailOk?: boolean;
  smsOk?: boolean;
  translate?: TranslationService['translate'];
  recordFails?: boolean;
} = {}) {
  const config = {
    surveyRemindersEnabled: opts.enabled ?? true,
    surveyReminderIdleMinutes: 30,
    surveyReminderCooldownMinutes: 60,
    surveyAbandonmentIdleMinutes: 120,
    surveyReminderMax: 2,
    surveySessionSweepCron: '*/5 * * * *',
    publicAppUrl: 'https://app.rio.example',
  } as unknown as ConfigService;
  const findMany = vi.fn().mockResolvedValue(opts.due ?? []);
  const updateMany = opts.recordFails
    ? vi.fn().mockRejectedValue(new Error('db'))
    : vi.fn().mockResolvedValue({ count: 1 });
  const tenant = {
    runAsSupervisor: vi.fn((fn: (tx: unknown) => unknown) => fn({ surveySession: { findMany } })),
    runAsOrg: vi.fn((_org: string, fn: (tx: unknown) => unknown) => fn({ surveySession: { updateMany } })),
  } as unknown as TenantPrismaService;
  const sessions = { sweepAbandoned: vi.fn().mockResolvedValue(0) } as unknown as SurveySessionsService;
  const mailer = {
    sendSurveyReminder: vi.fn().mockResolvedValue(opts.mailOk ?? true),
  } as unknown as MailerService;
  const sms = { sendSurveyReminder: vi.fn().mockResolvedValue(opts.smsOk ?? true) } as unknown as SmsService;
  const scheduler = { addCronJob: vi.fn() } as unknown as SchedulerRegistry;
  const translation = {
    translate:
      opts.translate ??
      vi.fn().mockResolvedValue({ translatedText: 'الوصول إلى المياه', unchanged: false }),
  } as unknown as TranslationService;
  const svc = new SurveyReminderService(config, tenant, sessions, mailer, sms, scheduler, translation);
  return { svc, mailer, sms, updateMany, findMany, sessions };
}

describe('SurveyReminderService.sweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends nothing while reminders are disabled (the default)', async () => {
    const { svc, findMany, mailer } = build({ enabled: false, due: [session()] });
    await expect(svc.sweep()).resolves.toEqual({ abandonedMarked: 0, remindersSent: 0, remindersSkipped: 0 });
    expect(findMany).not.toHaveBeenCalled();
    expect(mailer.sendSurveyReminder).not.toHaveBeenCalled();
  });

  it('emails an Arabic reminder with an /ar link and the Need title translated (UAT-02 / UAT-11)', async () => {
    const { svc, mailer, updateMany } = build({ due: [session()] });
    await expect(svc.sweep()).resolves.toMatchObject({ remindersSent: 1, remindersSkipped: 0 });
    expect(mailer.sendSurveyReminder).toHaveBeenCalledWith('citizen@example.test', {
      needTitle: 'Water access',
      needTitleAr: 'الوصول إلى المياه',
      publicUrl: 'https://app.rio.example/ar/public/survey/tok1',
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('falls back to the link label when the link has no Need', async () => {
    const { svc, mailer } = build({
      due: [session({ surveyLink: { token: 'tok1', label: 'Wave 1', need: null } })],
      translate: vi.fn().mockResolvedValue({ translatedText: '', unchanged: true }),
    });
    await svc.sweep();
    // An empty translation falls back to the source title, never a blank heading.
    expect(mailer.sendSurveyReminder).toHaveBeenCalledWith(
      'citizen@example.test',
      expect.objectContaining({ needTitle: 'Wave 1', needTitleAr: 'Wave 1' }),
    );
  });

  it('still sends when the translation lookup throws — a missed translation never costs the nudge', async () => {
    const { svc, mailer } = build({
      due: [session()],
      translate: vi.fn().mockRejectedValue(new Error('cache down')),
    });
    await expect(svc.sweep()).resolves.toMatchObject({ remindersSent: 1 });
    expect(mailer.sendSurveyReminder).toHaveBeenCalledWith(
      'citizen@example.test',
      expect.objectContaining({ needTitleAr: 'Water access' }),
    );
  });

  it('falls back to SMS when the email send fails and a mobile is on file', async () => {
    const { svc, sms } = build({ due: [session({ mobile: '+966501234567' })], mailOk: false });
    await expect(svc.sweep()).resolves.toMatchObject({ remindersSent: 1 });
    expect(sms.sendSurveyReminder).toHaveBeenCalledWith(
      '+966501234567',
      'https://app.rio.example/ar/public/survey/tok1',
    );
  });

  it('uses SMS directly for a mobile-only respondent', async () => {
    const { svc, mailer, sms } = build({ due: [session({ contact: null, mobile: '+966501234567' })] });
    await svc.sweep();
    expect(mailer.sendSurveyReminder).not.toHaveBeenCalled();
    expect(sms.sendSurveyReminder).toHaveBeenCalledTimes(1);
  });

  it('counts a session as skipped when no channel delivers', async () => {
    const { svc, updateMany } = build({
      due: [session({ mobile: '+966501234567' }), session({ id: 'ss2', contact: null, mobile: null })],
      mailOk: false,
      smsOk: false,
    });
    await expect(svc.sweep()).resolves.toMatchObject({ remindersSent: 0, remindersSkipped: 2 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not count a delivered reminder it could not record', async () => {
    const { svc } = build({ due: [session()], recordFails: true });
    await expect(svc.sweep()).resolves.toMatchObject({ remindersSent: 0, remindersSkipped: 0 });
  });

  it('never throws — a failing reminder pass or abandonment sweep is logged, not raised', async () => {
    const { svc, sessions } = build({ due: [session()] });
    (svc as unknown as { tenant: { runAsSupervisor: () => never } }).tenant.runAsSupervisor = () => {
      throw new Error('db down');
    };
    vi.mocked(sessions.sweepAbandoned).mockRejectedValue(new Error('db down'));
    await expect(svc.sweep()).resolves.toEqual({ abandonedMarked: 0, remindersSent: 0, remindersSkipped: 0 });
  });

  it('registers the sweep on the configured cron at startup', () => {
    const { svc } = build();
    const registry = (svc as unknown as { schedulerRegistry: { addCronJob: ReturnType<typeof vi.fn> } })
      .schedulerRegistry;
    svc.onModuleInit();
    expect(registry.addCronJob).toHaveBeenCalledWith('survey-session-sweep', expect.anything());
    // Stop the real CronJob so the test process can exit.
    (registry.addCronJob.mock.calls[0]![1] as { stop: () => void }).stop();
  });
});
