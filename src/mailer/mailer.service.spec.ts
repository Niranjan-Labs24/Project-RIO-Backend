import { vi } from 'vitest';
import { MailerService } from './mailer.service';
import type { ConfigService } from '../config/config.service';

// vi.mock is hoisted above this file's imports, so the mock factory below
// cannot close over a plain top-level `const`. vi.hoisted() defines the
// value inside that hoisted scope so `send` exists by the time the factory
// runs (Jest's `jest.fn()` doesn't need this because Jest allows
// referencing plain out-of-scope variables from the mock factory).
const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('resend', () => ({
  // A plain arrow function can't be used with `new` — Resend is
  // constructed as `new Resend(apiKey)`, so the mock needs a real
  // constructor function.
  Resend: vi.fn().mockImplementation(function (this: { emails: { send: typeof send } }) {
    this.emails = { send };
  }),
}));

function config(over: Partial<Record<string, unknown>> = {}): ConfigService {
  return {
    resendApiKey: 're_test_key', mailFrom: 'RIO <no-reply@rio.local>',
    corsOrigin: 'https://app.rio.example',
    ...over,
  } as unknown as ConfigService;
}

describe('MailerService', () => {
  beforeEach(() => { send.mockReset(); });

  it('sends and returns true when Resend is configured', async () => {
    send.mockResolvedValue({ data: { id: '1' }, error: null });
    const svc = new MailerService(config());
    await expect(svc.sendTemporaryPassword('a@b.test', 'Org', 'pw')).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends a formatted welcome email with the workspace, email, temp password, and a sign-in link', async () => {
    send.mockResolvedValue({ data: { id: '1' }, error: null });
    const svc = new MailerService(config());
    await svc.sendTemporaryPassword('a@b.test', 'Acme NGO', 'temp-pw-123');

    const firstCall = send.mock.calls[0];
    expect(firstCall).toBeDefined();
    const message = firstCall![0];
    expect(message.subject).toContain('Acme NGO');
    for (const body of [message.text, message.html]) {
      expect(body).toContain('Acme NGO');
      expect(body).toContain('a@b.test');
      expect(body).toContain('temp-pw-123');
      expect(body).toContain('https://app.rio.example');
    }
    // HTML-escaped even though nothing here needs escaping — guards against
    // an org name/email containing `<`/`&` breaking the markup later.
    expect(message.html).toContain('<h1');
  });

  it('returns false (no throw) when Resend is not configured', async () => {
    const svc = new MailerService(config({ resendApiKey: undefined }));
    await expect(svc.sendTemporaryPassword('a@b.test', 'Org', 'pw')).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns false when the send throws', async () => {
    send.mockRejectedValue(new Error('resend down'));
    const svc = new MailerService(config());
    await expect(svc.sendTemporaryPassword('a@b.test', 'Org', 'pw')).resolves.toBe(false);
  });

  it('returns false when Resend responds with an error object', async () => {
    send.mockResolvedValue({ data: null, error: { name: 'invalid_api_key', message: 'bad key', statusCode: 401 } });
    const svc = new MailerService(config());
    await expect(svc.sendTemporaryPassword('a@b.test', 'Org', 'pw')).resolves.toBe(false);
  });

  // UAT-11 — every email defaults to Arabic, including the internal ones.
  describe('Arabic by default (UAT-11)', () => {
    const sent = () => send.mock.calls[0]![0] as { subject: string; text: string; html: string };

    it('sends the backup failure alert in Arabic, naming the backup kind in Arabic', async () => {
      send.mockResolvedValue({ data: { id: '1' }, error: null });
      const svc = new MailerService(config());
      await svc.sendBackupFailureAlert(['ops@rio.test'], {
        kind: 'attachments', error: 'pg_dump: refused', runId: 'run-1', startedAt: new Date('2026-09-30T00:00:00Z'),
      });
      expect(sent().subject).toBe('فشل النسخ الاحتياطي في RIO — المرفقات');
      expect(sent().html).toContain('dir="rtl"');
      // The technical error stays verbatim (and left-to-right) for the admin.
      expect(sent().text).toContain('pg_dump: refused');
    });

    it('falls back to the raw kind for a backup kind with no Arabic name', async () => {
      send.mockResolvedValue({ data: { id: '1' }, error: null });
      const svc = new MailerService(config());
      await svc.sendBackupFailureAlert(['ops@rio.test'], {
        kind: 'snapshot', error: 'x', runId: 'run-2', startedAt: new Date('2026-09-30T00:00:00Z'),
      });
      expect(sent().subject).toBe('فشل النسخ الاحتياطي في RIO — snapshot');
    });

    it('sends the contact enquiry in Arabic', async () => {
      send.mockResolvedValue({ data: { id: '1' }, error: null });
      const svc = new MailerService(config());
      await svc.sendContactRequest(['team@rio.test'], {
        orgName: 'كيان تجريبي', name: 'سارة', email: 's@x.test', region: 'الرياض', purpose: 'تعاون',
      });
      expect(sent().subject).toBe('استفسار جديد في RIO — سارة (الرياض)');
      expect(sent().text).toContain('الاسم: سارة');
      expect(sent().html).toContain('dir="rtl"');
    });

    it('sends the survey reminder in Arabic with the translated Need title', async () => {
      send.mockResolvedValue({ data: { id: '1' }, error: null });
      const svc = new MailerService(config());
      await svc.sendSurveyReminder('c@x.test', {
        needTitle: 'Water', needTitleAr: 'المياه', publicUrl: 'https://app.rio.example/ar/public/survey/t',
      });
      expect(sent().subject).toBe('تذكير: لم تكتمل إجابتك على استبيان المياه');
      expect(sent().html).toContain('dir="rtl"');
      expect(sent().html).not.toContain('Finish the survey');
    });
  });
});
