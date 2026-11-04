import { describe, expect, it } from 'vitest';
import { normalizePersonName } from './person-name';

// UAT RSP-02 — respondent name rule.
describe('normalizePersonName', () => {
  it.each([
    ['Ahmed', 'Ahmed'],
    ['Ahmed Al-Harbi', 'Ahmed Al-Harbi'],
    ["Sara O'Neil", "Sara O'Neil"],
    ['محمد العتيبي', 'محمد العتيبي'],
    ['عبد الله', 'عبد الله'],
    ['علي', 'علي'],
    ['مُحَمَّد', 'مُحَمَّد'], // with tashkeel
    ['فاطمة الزهراء', 'فاطمة الزهراء'],
    ['  Noura   Al   Saud  ', 'Noura Al Saud'], // trimmed, single spaces
  ])('accepts %j as %j', (input, expected) => {
    expect(normalizePersonName(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'spaces only'],
    ['A', 'one letter'],
    ['Al', 'two letters (below the minimum of 3)'],
    ['12345', 'digits'],
    ['John123', 'letters with digits'],
    ['محمد٣', 'Arabic-Indic digit'],
    ['@@@ ###', 'symbols'],
    ['Ahmed!', 'trailing symbol'],
    ['-Ahmed', 'starts with a hyphen'],
    ["Ahmed '", 'ends with an apostrophe'],
    ['Ahmed--Ali', 'two separators in a row'],
    ['a'.repeat(101), 'longer than 100'],
  ])('refuses %j (%s)', (input) => {
    expect(normalizePersonName(input)).toBeNull();
  });
});
