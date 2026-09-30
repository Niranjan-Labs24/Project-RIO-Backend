import { describe, expect, it } from 'vitest';
import { toSaudiMobileE164 } from './saudi-mobile';

describe('toSaudiMobileE164', () => {
  it.each([
    '+966501234567',
    '966501234567',
    '00966501234567',
    '0501234567',
    '501234567',
    '+966 50 123 4567',
    '050-123-4567',
    '(050) 123 4567',
  ])('normalizes %s to +966501234567', (input) => {
    expect(toSaudiMobileE164(input)).toBe('+966501234567');
  });

  it.each([
    '',
    '+966401234567', // landline-style prefix, not 5
    '+96650123456', // one digit short
    '+9665012345678', // one digit long
    '+971501234567', // UAE
    '0112345678', // Riyadh landline
    'abc',
  ])('rejects %s', (input) => {
    expect(toSaudiMobileE164(input)).toBeNull();
  });
});
