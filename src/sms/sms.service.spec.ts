import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above this file's imports, so the mock factory below
// can't reference outer-scope variables — same pattern as mailer.service.spec.ts.
const createMock = vi.fn();
const twilioFactoryMock = vi.fn((_sid: string, _token: string, _opts: { timeout: number }) => ({
  messages: { create: createMock },
}));

vi.mock('twilio', () => ({
  default: (sid: string, token: string, opts: { timeout: number }) => twilioFactoryMock(sid, token, opts),
}));

import { SmsService } from './sms.service';

function makeConfig(overrides: Partial<{
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  smsTimeoutMs: number;
}> = {}) {
  return {
    twilioAccountSid: 'ACxxxx',
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

  it('constructs the Twilio client with the configured timeout', () => {
    new SmsService(makeConfig({ smsTimeoutMs: 12_345 }));
    expect(twilioFactoryMock).toHaveBeenCalledWith('ACxxxx', 'token', { timeout: 12_345 });
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

  it('returns false (no throw) when Twilio is not configured', async () => {
    const service = new SmsService(makeConfig({ twilioAccountSid: undefined }));
    const result = await service.sendOtpCode('+15559876543', '123456');
    expect(result).toBe(false);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns false (no throw) when the send times out or otherwise rejects', async () => {
    createMock.mockRejectedValue(new Error('ETIMEDOUT'));
    const service = new SmsService(makeConfig());
    const result = await service.sendOtpCode('+15559876543', '123456');
    expect(result).toBe(false);
  });
});
