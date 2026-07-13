import { MailerService } from './mailer.service';
import type { ConfigService } from '../config/config.service';

function makeFakeConfig(resendApiKey: string | undefined): ConfigService {
  return {
    resendApiKey,
    mailFrom: 'Rio <onboarding@resend.dev>',
    corsOrigin: 'http://localhost:3001',
  } as unknown as ConfigService;
}

describe('MailerService', () => {
  it('is not configured when RESEND_API_KEY is unset', () => {
    const mailer = new MailerService(makeFakeConfig(undefined));
    expect(mailer.isConfigured).toBe(false);
  });

  it('is configured when RESEND_API_KEY is set', () => {
    const mailer = new MailerService(makeFakeConfig('re_test_key'));
    expect(mailer.isConfigured).toBe(true);
  });

  it('sendTemporaryPassword returns false without throwing when unconfigured', async () => {
    const mailer = new MailerService(makeFakeConfig(undefined));
    const result = await mailer.sendTemporaryPassword('someone@demo.org', 'Demo Org', 'temp-pw-123');
    expect(result).toBe(false);
  });
});
