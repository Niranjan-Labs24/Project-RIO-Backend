import { describe, expect, it } from 'vitest';
import { sanitizeForSpreadsheet } from './spreadsheet-sanitize';

describe('sanitizeForSpreadsheet', () => {
  it('prefixes values starting with =, +, -, or @ with a single quote', () => {
    expect(sanitizeForSpreadsheet('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(sanitizeForSpreadsheet('+1+1')).toBe("'+1+1");
    expect(sanitizeForSpreadsheet('-2+3')).toBe("'-2+3");
    expect(sanitizeForSpreadsheet('@SUM(1,2)')).toBe("'@SUM(1,2)");
  });

  it('cannot be bypassed by leading whitespace before a formula marker', () => {
    expect(sanitizeForSpreadsheet('   =cmd|/c calc')).toBe("'   =cmd|/c calc");
    expect(sanitizeForSpreadsheet('\t=1+1')).toBe("'\t=1+1");
  });

  it('cannot be bypassed by leading control characters (tab, CR, LF) before a formula marker', () => {
    expect(sanitizeForSpreadsheet('\r=1+1')).toBe("'\r=1+1");
    expect(sanitizeForSpreadsheet('\n=1+1')).toBe("'\n=1+1");
    expect(sanitizeForSpreadsheet('\t\r\n=1+1')).toBe("'\t\r\n=1+1");
  });

  it('leaves ordinary names unchanged', () => {
    expect(sanitizeForSpreadsheet('Amira Al-Fahad')).toBe('Amira Al-Fahad');
    expect(sanitizeForSpreadsheet('')).toBe('');
  });

  it('leaves a phone number starting with + only prefixed, never mangled', () => {
    // The leading quote is the accepted, industry-standard mitigation — it
    // is never rendered by Excel/Sheets once opened, so the visible value
    // still reads as the original phone number.
    const result = sanitizeForSpreadsheet('+966501234567');
    expect(result).toBe("'+966501234567");
    expect(result.slice(1)).toBe('+966501234567');
  });

  it('leaves Arabic/Unicode text unchanged', () => {
    expect(sanitizeForSpreadsheet('مرحبا بالعالم')).toBe('مرحبا بالعالم');
  });

  it('does not treat a formula marker appearing mid-string as dangerous', () => {
    expect(sanitizeForSpreadsheet('cost=5')).toBe('cost=5');
    expect(sanitizeForSpreadsheet('a+b=c')).toBe('a+b=c');
  });

  it('leaves whitespace-only or empty-after-trim values unchanged', () => {
    expect(sanitizeForSpreadsheet('   ')).toBe('   ');
    expect(sanitizeForSpreadsheet('\t\r\n')).toBe('\t\r\n');
  });
});
