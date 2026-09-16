import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above this file's imports, so the mock factory below
// can't reference outer-scope variables — same pattern as mailer.service.spec.ts.
const createMock = vi.fn();
const twilioFactoryMock = vi.fn(
  (
    _idOrKey: string,
    _secret: string,
    _opts: { timeout: number; accountSid?: string },
  ) => ({
    messages: { create: createMock },
  }),
);

vi.mock('twilio', () => ({
  default: (
    idOrKey: string,
    secret: string,
    opts: { timeout: number; accountSid?: string },
  ) => twilioFactoryMock(idOrKey, secret, opts),
}));

import { SmsService } from './sms.service';

function makeConfig(
  overrides: Partial<{
    twilioAccountSid?: string;
    twilioApiKeySid?: string;
    twilioApiKeySecret?: string;
    twilioAuthToken?: string;
    twilioFromNumber?: string;
    smsTimeoutMs: number;
  }> = {},
) {
  return {
    twilioAccountSid: 'ACxxxx',
    twilioApiKeySid: undefined,
    twilioApiKeySecret: undefined,
    twilioAuthToken: 'token',
    twilioFromNumber: '+15551234567',
    smsTimeoutMs: 10_000,
    ...overrides,
  } as never;
}

describe('SmsService', () => {
  beforeEach(() => {
    createMock.mockReset();
    twilioFactoryMock.mockClear();
  });

  it('constructs the Twilio client with the Auth Token when no API key is set', () => {
    new SmsService(makeConfig({ smsTimeoutMs: 12_345 }));
    expect(twilioFactoryMock).toHaveBeenCalledWith('ACxxxx', 'token', {
      timeout: 12_345,
    });
  });

  it('prefers API-Key auth: key SID + secret + explicit accountSid', () => {
    new SmsService(
      makeConfig({
        twilioApiKeySid: 'SKabc',
        twilioApiKeySecret: 'keysecret',
        smsTimeoutMs: 9_000,
      }),
    );
    expect(twilioFactoryMock).toHaveBeenCalledWith('SKabc', 'keysecret', {
      timeout: 9_000,
      accountSid: 'ACxxxx',
    });
  });

  it('sends and returns true when Twilio is configured', async () => {
    createMock.mockResolvedValue({ sid: 'SM123' });
    const service = new SmsService(makeConfig());
    const result = await service.sendOtpCode('+15559876543', '123456');
    expect(result).toBe(true);
    expect(createMock).toHaveBeenCalledWith({
      to: '+15559876543',
      from: '+15551234567',
      body: expect.stringContaining('123456'),
    });
  });

  it('returns false (no throw) when the account SID is missing', async () => {
    const service = new SmsService(makeConfig({ twilioAccountSid: undefined }));
    const result = await service.sendOtpCode('+15559876543', '123456');
    expect(result).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
    expect(twilioFactoryMock).not.toHaveBeenCalled();
  });

  it('returns false (no throw) when a from-number is missing', async () => {
    const service = new SmsService(makeConfig({ twilioFromNumber: undefined }));
    expect(await service.sendOtpCode('+15559876543', '123456')).toBe(false);
    expect(twilioFactoryMock).not.toHaveBeenCalled();
  });

  it('returns false (no throw) when account SID + from-number are set but no credential is', async () => {
    const service = new SmsService(
      makeConfig({ twilioAuthToken: undefined }), // and no API key either
    );
    expect(await service.sendOtpCode('+15559876543', '123456')).toBe(false);
    expect(twilioFactoryMock).not.toHaveBeenCalled();
  });

  it('returns false (no throw) when the send times out or otherwise rejects', async () => {
    createMock.mockRejectedValue(new Error('ETIMEDOUT'));
    const service = new SmsService(makeConfig());
    const result = await service.sendOtpCode('+15559876543', '123456');
    expect(result).toBe(false);
  });
});
