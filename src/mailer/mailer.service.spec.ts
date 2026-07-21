import { vi } from 'vitest';
import { MailerService } from './mailer.service';
import type { ConfigService } from '../config/config.service';

// vi.mock is hoisted above this file's imports, so the mock factory below
// cannot close over a plain top-level `const`. vi.hoisted() defines the
// value inside that hoisted scope so `sendMail` exists by the time the
// factory runs (Jest's `jest.fn()` doesn't need this because Jest allows
// referencing plain out-of-scope variables from the mock factory).
const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({ sendMail })),
}));

function config(over: Partial<Record<string, unknown>> = {}): ConfigService {
  return {
    smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecure: false,
    smtpUser: undefined, smtpPass: undefined, mailFrom: 'RIO <no-reply@rio.local>',
    corsOrigin: 'https://app.rio.example',
    ...over,
  } as unknown as ConfigService;
}

describe('MailerService', () => {
  beforeEach(() => { sendMail.mockReset(); });

  it('sends and returns true when SMTP is configured', async () => {
    sendMail.mockResolvedValue({ messageId: '1' });
    const svc = new MailerService(config());
    await expect(svc.sendTemporaryPassword('a@b.test', 'Org', 'pw')).resolves.toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('sends a formatted welcome email with the workspace, email, temp password, and a sign-in link', async () => {
    sendMail.mockResolvedValue({ messageId: '1' });
    const svc = new MailerService(config());
    await svc.sendTemporaryPassword('a@b.test', 'Acme NGO', 'temp-pw-123');

    const firstCall = sendMail.mock.calls[0];
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

  it('returns false (no throw) when SMTP is not configured', async () => {
    const svc = new MailerService(config({ smtpHost: undefined }));
    await expect(svc.sendTemporaryPassword('a@b.test', 'Org', 'pw')).resolves.toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('returns false when the send throws', async () => {
    sendMail.mockRejectedValue(new Error('smtp down'));
    const svc = new MailerService(config());
    await expect(svc.sendTemporaryPassword('a@b.test', 'Org', 'pw')).resolves.toBe(false);
  });
});
