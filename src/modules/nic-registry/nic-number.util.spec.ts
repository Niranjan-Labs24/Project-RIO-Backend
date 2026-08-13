import { NIC_NUMBER_PATTERN, normalizeNicNumber } from './nic-number.util';

describe('normalizeNicNumber', () => {
  it('leaves an already-canonical number untouched', () => {
    expect(normalizeNicNumber('7011038218')).toBe('7011038218');
  });

  it('strips the separators people type or paste', () => {
    expect(normalizeNicNumber('  7011038218 ')).toBe('7011038218');
    expect(normalizeNicNumber('7011-038-218')).toBe('7011038218');
    expect(normalizeNicNumber('7011 038 218')).toBe('7011038218');
    expect(normalizeNicNumber('7011.038.218')).toBe('7011038218');
    // NBSP and a bidi mark, as copied out of an Arabic PDF.
    expect(normalizeNicNumber('7011 038‏218')).toBe('7011038218');
  });

  it('folds Arabic-Indic and Extended Arabic-Indic digits to ASCII', () => {
    expect(normalizeNicNumber('٧٠١١٠٣٨٢١٨')).toBe('7011038218');
    expect(normalizeNicNumber('۷۰۱۱۰۳۸۲۱۸')).toBe('7011038218');
    // Mixed, which is what an Arabic keyboard plus a paste actually produces.
    expect(normalizeNicNumber('٧٠١١-038218')).toBe('7011038218');
  });

  it('returns an empty string for absent input', () => {
    expect(normalizeNicNumber('')).toBe('');
    expect(normalizeNicNumber(null)).toBe('');
    expect(normalizeNicNumber(undefined)).toBe('');
  });

  it('does not launder non-separator junk into a valid-looking number', () => {
    // The reason normalization strips a fixed separator list rather than
    // every non-digit: this must stay invalid, not become '7011038218'.
    expect(NIC_NUMBER_PATTERN.test(normalizeNicNumber('7011038218INVALID'))).toBe(false);
    expect(NIC_NUMBER_PATTERN.test(normalizeNicNumber('NGO123456'))).toBe(false);
  });

  it('pairs with a pattern that only accepts exactly 10 digits', () => {
    expect(NIC_NUMBER_PATTERN.test('7011038218')).toBe(true);
    expect(NIC_NUMBER_PATTERN.test('701103821')).toBe(false);
    expect(NIC_NUMBER_PATTERN.test('70110382180')).toBe(false);
  });
});
