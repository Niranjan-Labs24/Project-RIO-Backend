import { describe, expect, it } from 'vitest';
import { normalizePersonName } from './person-name';

describe('normalizePersonName (UAT RSP-02)', () => {
  it.each([
    ['Sara', 'Sara'],
    ['  Sara   Al  Harbi ', 'Sara Al Harbi'],
    ['سارة الحربي', 'سارة الحربي'],
    ['مُحَمَّد', 'مُحَمَّد'],
    ['Al', 'Al'],
  ])('accepts %j as %j', (input, expected) => {
    expect(normalizePersonName(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['A', 'one letter'],
    ['A1', 'a digit'],
    ['سارة٣', 'an Arabic-Indic digit'],
    ['Sara!', 'a symbol'],
    ['sara@x.org', 'an email'],
    ['ـــ', 'only tatweel'],
  ])('refuses %j (%s)', (input) => {
    expect(normalizePersonName(input)).toBeNull();
  });
});
