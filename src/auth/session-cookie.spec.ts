import { describe, expect, it } from 'vitest';
import { sessionCookieOptions, tokenLifetimeSeconds } from './session-cookie';

describe('tokenLifetimeSeconds', () => {
  it('parses JWT-style durations', () => {
    expect(tokenLifetimeSeconds('12h')).toBe(43_200);
    expect(tokenLifetimeSeconds('30m')).toBe(1_800);
    expect(tokenLifetimeSeconds('7d')).toBe(604_800);
    expect(tokenLifetimeSeconds('90')).toBe(90);
  });
  it('falls back to 12 hours for anything else', () => {
    expect(tokenLifetimeSeconds('soon')).toBe(43_200);
  });
});

describe('sessionCookieOptions', () => {
  it('expires with the token, not days after it', () => {
    expect(sessionCookieOptions(false, '12h').maxAge).toBe(43_200_000);
  });
});
