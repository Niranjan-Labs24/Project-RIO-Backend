import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailerService } from './mailer.service';
import type { ConfigService } from '../config/config.service';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(function (this: { emails: { send: typeof send } }) {
    this.emails = { send };
  }),
}));

function config(over: Record<string, unknown> = {}): ConfigService {
  return {
    mailProvider: 'resend',
    resendApiKey: 're_key',
    mailFrom: 'RIO <no-reply@rio.local>',
    corsOrigin: 'https://app.rio.example',
    twilioEmailApiKeySid: 'sid',
    twilioEmailApiKeySecret: 'secret',
    twilioEmailFromAddress: 'from@twilio.test',
    twilioEmailFromName: 'RIO',
    sendgridApiKey: 'SG.key',
    sendgridFromAddress: 'from@sendgrid.test',
    sendgridFromName: 'RIO',
    ...over,
  } as unknown as ConfigService;
}

const survey = {
  needTitle: 'Water',
  linkLabel: 'Wave 1',
  publicUrl: 'https://s/1',
  qrCodePng: Buffer.from('png'),
};
const enquiry = {
  orgName: 'Acme',
  name: 'Ana',
  email: 'ana@acme.test',
  region: 'Riyadh',
  purpose: 'Join <us>',
};
const backup = {
  kind: 'daily',
  error: 'disk full',
  runId: 'run-1',
  startedAt: new Date('2026-09-01T00:00:00Z'),
};

/** Every message the service can send, as [label, call]. */
const senders: Array<[string, (m: MailerService) => Promise<boolean>]> = [
  ['temporary password', (m) => m.sendTemporaryPassword('a@b.test', 'Acme', 'pw-1')],
  ['password reset', (m) => m.sendPasswordResetEmail('a@b.test', 'https://app/reset?t=1')],
  ['login OTP', (m) => m.sendLoginOtpEmail('a@b.test', '123456')],
  ['contact request', (m) => m.sendContactRequest(['x@y.test', 'z@y.test'], enquiry)],
  ['survey link', (m) => m.sendSurveyLink('a@b.test', survey)],
  ['survey reminder', (m) => m.sendSurveyReminder('a@b.test', survey)],
  ['backup failure', (m) => m.sendBackupFailureAlert(['x@y.test'], backup)],
];

describe.each([
  ['twilio', 'https://comms.twilio.com/v1/Emails'],
  ['sendgrid', 'https://api.sendgrid.com/v3/mail/send'],
])('MailerService over %s', (provider, url) => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(senders)('sends the %s email to the provider', async (_label, call) => {
    const svc = new MailerService(config({ mailProvider: provider }));
    await expect(call(svc)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(url);
  });

  it('includes bcc and reply-to for a contact enquiry, and the QR attachment for a survey link', async () => {
    const svc = new MailerService(config({ mailProvider: provider }));
    await svc.sendContactRequest(['x@y.test'], enquiry);
    const contact = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(JSON.stringify(contact)).toContain('x@y.test');
    expect(JSON.stringify(contact)).toContain('ana@acme.test');

    await svc.sendSurveyLink('a@b.test', survey);
    const link = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(JSON.stringify(link)).toContain(Buffer.from('png').toString('base64'));
    expect(JSON.stringify(link)).toContain('image/png');
  });

  it('reports a provider error status as a failed send', async () => {
    fetchMock.mockResolvedValue(new Response('quota', { status: 429 }));
    const svc = new MailerService(config({ mailProvider: provider }));
    await expect(svc.sendLoginOtpEmail('a@b.test', '1')).resolves.toBe(false);
  });

  it('uses the status text when the error body cannot be read', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: () => Promise.reject(new Error('x')),
    });
    const svc = new MailerService(config({ mailProvider: provider }));
    await expect(svc.sendSurveyReminder('a@b.test', survey)).resolves.toBe(false);
  });

  it('reports a network failure as a failed send', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const svc = new MailerService(config({ mailProvider: provider }));
    await expect(svc.sendBackupFailureAlert(['x@y.test'], backup)).resolves.toBe(false);
  });

  it('records send failures in the system log when one is available', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 500 }));
    const record = vi.fn();
    const svc = new MailerService(config({ mailProvider: provider }), { record } as never);
    await svc.sendSurveyLink('a@b.test', survey);
    expect(record).toHaveBeenCalled();
  });
});

describe('MailerService without a configured provider', () => {
  it.each([
    ['twilio with no credentials', { mailProvider: 'twilio', twilioEmailApiKeySid: undefined }],
    ['sendgrid with no key', { mailProvider: 'sendgrid', sendgridApiKey: undefined }],
    ['resend with no key', { mailProvider: 'resend', resendApiKey: undefined }],
  ])('%s sends nothing and reports false', async (_label, over) => {
    const svc = new MailerService(config(over));
    for (const [, call] of senders) await expect(call(svc)).resolves.toBe(false);
  });

  it('refuses to send to an empty recipient list', async () => {
    const svc = new MailerService(config());
    await expect(svc.sendContactRequest([], enquiry)).resolves.toBe(false);
    await expect(svc.sendBackupFailureAlert([], backup)).resolves.toBe(false);
  });
});

describe('MailerService over Resend', () => {
  beforeEach(() => send.mockReset());

  it.each(senders.filter(([l]) => l !== 'temporary password'))(
    'sends the %s email',
    async (_l, call) => {
      send.mockResolvedValue({ data: { id: '1' }, error: null });
      await expect(call(new MailerService(config()))).resolves.toBe(true);
    },
  );

  it.each(senders.filter(([l]) => l !== 'temporary password' && l !== 'password reset'))(
    'reports a Resend error for the %s email as a failed send',
    async (_l, call) => {
      send.mockResolvedValue({ data: null, error: { name: 'x', message: 'bad' } });
      await expect(call(new MailerService(config()))).resolves.toBe(false);
    },
  );

  it('reports a thrown Resend failure as a failed send and logs it', async () => {
    const record = vi.fn();
    const svc = new MailerService(config(), { record } as never);
    for (const [label, call] of senders) {
      if (label === 'temporary password' || label === 'password reset') continue;
      send.mockRejectedValueOnce(new Error('down'));
      const result = await call(svc);
      expect(result, label).toBe(false);
    }
    expect(record).toHaveBeenCalledTimes(5);
  });
});
