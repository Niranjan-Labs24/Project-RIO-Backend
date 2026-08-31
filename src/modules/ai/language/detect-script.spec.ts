import { describe, expect, it } from 'vitest';
import { containsArabic, detectLanguage, latinRuns } from './detect-script';

/**
 * The fixtures matter more than the function. Detection decides which language
 * a stored summary is labelled as, which rows a backfill flags, and whether a
 * generated report is accepted as Arabic — so the cases below are written from
 * what real field data looks like, not from what is easy to classify.
 */
describe('detectLanguage', () => {
  it('classifies pure Arabic', () => {
    expect(detectLanguage('لا تتوفر مياه شرب نظيفة في القرية منذ ثلاثة أشهر')).toBe('ar');
  });

  it('classifies pure English', () => {
    expect(detectLanguage('The village has had no clean drinking water for three months')).toBe('en');
  });

  it('keeps Arabic that borrows English domain terms', () => {
    // The case that breaks a naive majority rule, and the one that actually
    // occurs: a field researcher writing Arabic prose but naming the domain,
    // the partner org or a programme in English.
    expect(
      detectLanguage('يحتاج المركز إلى دعم في مجال Water and Sanitation بشكل عاجل'),
    ).toBe('ar');
  });

  it('keeps English that carries Arabic place names', () => {
    expect(detectLanguage('Water shortage reported in الجموم and surrounding villages')).toBe('en');
  });

  it('returns the default for text with no letters at all', () => {
    // A statement of "50 / 120 (41.6%)" is not Arabic and not English; it has
    // nothing to detect, so it must answer the default rather than guess.
    expect(detectLanguage('50 / 120 (41.6%)')).toBe('en');
    expect(detectLanguage('')).toBe('en');
    expect(detectLanguage('   \n\t  ')).toBe('en');
    expect(detectLanguage('١٢٣ ٤٥٦')).toBe('en');
  });

  it('ignores digits and punctuation when weighing the two scripts', () => {
    // Same words, one drowned in numbers. If digits counted, the second would
    // fall under the threshold and flip — which would make any statement
    // carrying survey figures unclassifiable.
    expect(detectLanguage('مياه')).toBe('ar');
    expect(detectLanguage('مياه 123456789 987654321 (100%) — 55/60')).toBe('ar');
  });

  it('honours an explicit threshold', () => {
    const mixed = 'Water مياه'; // 5 Latin letters, 4 Arabic
    expect(detectLanguage(mixed, 0.9)).toBe('en');
    expect(detectLanguage(mixed, 0.1)).toBe('ar');
  });

  it('reads Arabic presentation forms, not just the main block', () => {
    // Text pasted from older Windows tooling arrives in FB50–FDFF/FE70–FEFF.
    // Missing this block would mislabel a real paste as English.
    expect(detectLanguage('ﻣﻴﺎﻩ ﺷﺮﺏ')).toBe('ar');
  });
});

describe('containsArabic', () => {
  it('detects a single Arabic letter among Latin text', () => {
    expect(containsArabic('Village م')).toBe(true);
    expect(containsArabic('Village')).toBe(false);
    expect(containsArabic('123 456')).toBe(false);
  });
});

describe('latinRuns', () => {
  it('reports untranslated Latin words in Arabic output', () => {
    expect(latinRuns('تقرير القرية Water and Sanitation')).toEqual(['Water', 'and', 'Sanitation']);
  });

  it('does not report digits or punctuation as English', () => {
    // Western digits inside Arabic text are an open formatting question, not a
    // translation failure — flagging them would make the guarantee unusable.
    expect(latinRuns('نسبة الاستجابة 41.6% (50/120)')).toEqual([]);
  });

  it('ignores single stray letters by default', () => {
    // Unit symbols and list markers, not untranslated prose.
    expect(latinRuns('المساحة 5 m و 3 km')).toEqual(['km']);
    expect(latinRuns('المساحة 5 m', 1)).toEqual(['m']);
  });

  it('returns nothing for fully Arabic text', () => {
    expect(latinRuns('لا تتوفر مياه شرب نظيفة في القرية')).toEqual([]);
  });
});
