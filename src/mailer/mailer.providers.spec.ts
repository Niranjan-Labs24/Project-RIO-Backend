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
  needTitleAr: 'مياه',
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

/**
 * The public survey's OTP is the one email that may be billed to a second,
 * unrelated account (SURVEY_OTP_MAIL_PROVIDER). These prove the two halves
 * that matter: that it really does leave through the other account, and
 * that nothing else follows it there.
 */
describe('MailerService survey-OTP-only account', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    send.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Main account on Twilio, citizen OTP on the client's SendGrid. */
  const split = {
    mailProvider: 'twilio',
    surveyOtpMailProvider: 'sendgrid',
    surveyOtpSendgridApiKey: 'SG.client_key',
    surveyOtpSendgridFromAddress: 'otp@client.test',
    surveyOtpSendgridFromName: 'RIO',
  };

  const authOf = (call: number) => fetchMock.mock.calls[call]![1].headers.Authorization;

  it('sends the citizen OTP through the second account', async () => {
    const svc = new MailerService(config(split));
    await expect(svc.sendCitizenOtpEmail('a@b.test', '123456')).resolves.toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(authOf(0)).toBe('Bearer SG.client_key');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).from.email).toBe('otp@client.test');
  });

  it('leaves every other email on the main account', async () => {
    const svc = new MailerService(config(split));
    for (const [, call] of senders) await expect(call(svc)).resolves.toBe(true);
    const twilioAuth = `Basic ${Buffer.from('sid:secret').toString('base64')}`;
    for (let i = 0; i < senders.length; i++) {
      expect(fetchMock.mock.calls[i]![0]).toBe('https://comms.twilio.com/v1/Emails');
      expect(authOf(i)).toBe(twilioAuth);
    }
  });

  it('keeps the citizen OTP on the main account when no second account is set', async () => {
    const svc = new MailerService(config({ mailProvider: 'twilio' }));
    await expect(svc.sendCitizenOtpEmail('a@b.test', '1')).resolves.toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://comms.twilio.com/v1/Emails');
  });

  it('falls back to the main account when the second one is half-configured', async () => {
    // A mistyped credential must not leave respondents unable to submit.
    const svc = new MailerService(config({ ...split, surveyOtpSendgridApiKey: undefined }));
    await expect(svc.sendCitizenOtpEmail('a@b.test', '1')).resolves.toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://comms.twilio.com/v1/Emails');
  });

  it("sends the citizen OTP over Twilio's own Emails API when that is the second account", async () => {
    // The reverse split, and the one the client is most likely to want: no
    // SendGrid account at all on their side, just a Twilio Email API key.
    const svc = new MailerService(
      config({
        mailProvider: 'sendgrid',
        surveyOtpMailProvider: 'twilio',
        surveyOtpTwilioEmailApiKeySid: 'SKclient',
        surveyOtpTwilioEmailApiKeySecret: 'clientsecret',
        surveyOtpTwilioEmailFromAddress: 'otp@client.test',
        surveyOtpTwilioEmailFromName: 'RIO',
      }),
    );

    await expect(svc.sendCitizenOtpEmail('a@b.test', '123456')).resolves.toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://comms.twilio.com/v1/Emails');
    expect(authOf(0)).toBe(`Basic ${Buffer.from('SKclient:clientsecret').toString('base64')}`);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).from.address).toBe('otp@client.test');

    // ...and the main account is untouched: still SendGrid, still its key.
    await expect(svc.sendLoginOtpEmail('a@b.test', '1')).resolves.toBe(true);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(authOf(1)).toBe('Bearer SG.key');
  });

  it('names the second account, not the main one, when its send fails', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));
    const record = vi.fn();
    const svc = new MailerService(config(split), { record } as never);
    await expect(svc.sendCitizenOtpEmail('a@b.test', '1')).resolves.toBe(false);
    expect(record.mock.calls[0]![0].context.provider).toBe('sendgrid');
  });
});
