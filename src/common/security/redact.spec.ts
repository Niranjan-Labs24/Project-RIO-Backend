import { describe, expect, it } from 'vitest';
import { redactEmail, redactPhone } from './redact';

describe('redactEmail', () => {
  it('keeps the first character and domain, masks the rest of the local part', () => {
    expect(redactEmail('priya@demo-ngo.org')).toBe('p****@demo-ngo.org');
  });

  it('handles a single-character local part', () => {
    expect(redactEmail('a@example.org')).toBe('a*@example.org');
  });

  it('never reveals the full original address', () => {
    const result = redactEmail('officer@demo-ngo.org');
    expect(result).not.toBe('officer@demo-ngo.org');
    expect(result).not.toContain('fficer');
  });
});

describe('redactPhone', () => {
  it('keeps only the last 4 digits', () => {
    expect(redactPhone('+15559876543')).toBe('***6543');
  });

  it('ignores formatting characters', () => {
    expect(redactPhone('+1 (555) 987-6543')).toBe('***6543');
  });

  it('fully masks a short/invalid number', () => {
    expect(redactPhone('123')).toBe('***');
  });
});
