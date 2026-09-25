import { describe, expect, it } from 'vitest';
import { numericTokens, rejectTranslation, residualEnglishWords } from './translation-quality';

describe('numericTokens', () => {
  it('reads Arabic-Indic digits and the Arabic decimal separator as the same figures', () => {
    expect(numericTokens('٣٣٫٧٢ و ١٢')).toEqual(numericTokens('33.72 and 12'));
  });

  it('ignores thousands separators', () => {
    expect(numericTokens('1,200 responses')).toEqual(['1200']);
  });
});

describe('residualEnglishWords', () => {
  it('keeps acronyms and codes, flags ordinary words', () => {
    expect(residualEnglishWords('مؤشر KPI و SLA في RPT01 و HLT-01')).toEqual([]);
    expect(residualEnglishWords('الحاجة إلى water')).toEqual(['water']);
  });

  it('ignores words too short to be untranslated prose', () => {
    expect(residualEnglishWords('نسبة of the')).toEqual([]);
  });
});

describe('rejectTranslation', () => {
  it('accepts a clean Arabic translation that keeps every figure', () => {
    expect(rejectTranslation('Severity is 63.8 (HIGH)', 'الشدة 63.8 (HIGH)', 'ar')).toBeNull();
  });

  it('rejects a changed, dropped or added figure', () => {
    expect(rejectTranslation('Score 63.8', 'الدرجة 64', 'ar')).toBe('NUMBERS_CHANGED');
    expect(rejectTranslation('Score 63.8 of 100', 'الدرجة 63.8', 'ar')).toBe('NUMBERS_CHANGED');
  });

  it('rejects an Arabic answer with English prose left in it', () => {
    expect(rejectTranslation('Water access is limited', 'الوصول إلى water محدود', 'ar')).toBe(
      'ENGLISH_REMAINS',
    );
  });

  it('rejects an English answer with Arabic left in it', () => {
    expect(rejectTranslation('المياه محدودة', 'Water is محدودة', 'en')).toBe('ARABIC_REMAINS');
  });

  it('rejects an empty answer to a non-empty source', () => {
    expect(rejectTranslation('Water', '   ', 'ar')).toBe('EMPTY');
  });
});
