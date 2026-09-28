import { describe, expect, it } from 'vitest';
import { shouldRevealOtp } from './citizen.service';

describe('shouldRevealOtp', () => {
  it('reveals the code only in development and test when the SMS was not delivered', () => {
    expect(shouldRevealOtp(false, 'development')).toBe(true);
    expect(shouldRevealOtp(false, 'test')).toBe(true);
  });

  it('never reveals it once the SMS was delivered', () => {
    expect(shouldRevealOtp(true, 'development')).toBe(false);
    expect(shouldRevealOtp(true, 'test')).toBe(false);
  });

  it.each(['production', 'staging', 'prod', '', undefined])('fails closed for NODE_ENV=%s', (env) => {
    expect(shouldRevealOtp(false, env)).toBe(false);
  });
});
