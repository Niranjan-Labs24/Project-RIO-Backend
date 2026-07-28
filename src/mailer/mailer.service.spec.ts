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
});
