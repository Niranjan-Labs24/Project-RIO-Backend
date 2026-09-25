import type { SupportedLocale } from './translation.types';

// Checks a model's translation BEFORE it is cached or persisted.
//
// Everything this module guards against has happened for real: the provider
// answering with the source text half-translated, and that half-English
// answer being cached permanently so every later view reused it. A cached
// translation is never re-checked, so the check has to happen before the
// write, not at display time.

const ARABIC_INDIC_DIGITS = /[٠-٩]/g;
const EXTENDED_ARABIC_INDIC_DIGITS = /[۰-۹]/g;

/** Western digits for any Arabic-Indic ones, so "٣٣٫٧٢" and "33.72" compare equal. */
function toWesternDigits(text: string): string {
  return text
    .replace(ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.') // Arabic decimal separator
    .replace(/٬/g, ','); // Arabic thousands separator
}

/** Every number in the text, as a sorted list — the multiset of figures. */
export function numericTokens(text: string): string[] {
  const western = toWesternDigits(text);
  const matches = western.match(/\d+(?:[.,]\d+)*/g) ?? [];
  // Thousands separators differ between locales ("1,200" vs "1200"); compare
  // the digits only so a legitimate reformat is not rejected.
  return matches.map((m) => m.replace(/,/g, '')).sort();
}

/**
 * Latin words left in an Arabic translation that should not be there.
 *
 * Allowed: acronyms and codes (all caps, or containing a digit — KPI, SLA,
 * RPT01, HLT-01), because those are kept in Latin on purpose everywhere else
 * in the export. Anything else of four letters or more is a word the model
 * failed to translate.
 */
export function residualEnglishWords(text: string): string[] {
  const words = text.match(/[A-Za-z][A-Za-z0-9'-]*/g) ?? [];
  return words.filter((w) => {
    const letters = w.replace(/[^A-Za-z]/g, '');
    if (letters.length < 4) return false;
    if (/\d/.test(w)) return false;
    if (w === w.toUpperCase()) return false;
    return true;
  });
}

export type TranslationRejection =
  'EMPTY' | 'NUMBERS_CHANGED' | 'ENGLISH_REMAINS' | 'ARABIC_REMAINS';

/**
 * Why a translation of `source` into `targetLocale` must not be stored, or
 * null when it is safe to keep.
 */
export function rejectTranslation(
  source: string,
  translated: string,
  targetLocale: SupportedLocale,
): TranslationRejection | null {
  if (translated.trim().length === 0 && source.trim().length > 0) return 'EMPTY';

  const before = numericTokens(source);
  const after = numericTokens(translated);
  if (before.length !== after.length || before.some((n, i) => n !== after[i])) {
    return 'NUMBERS_CHANGED';
  }

  // Strict on purpose: the content-translation prompt already tells the model
  // to transliterate a proper noun into Arabic script, so a Latin word left
  // behind is a failure, not a kept name. Rejecting means "don't cache" — the
  // text still displays, and the next request retries.
  if (targetLocale === 'ar' && residualEnglishWords(translated).length > 0) {
    return 'ENGLISH_REMAINS';
  }
  if (targetLocale === 'en' && /[؀-ۿ]/.test(translated)) return 'ARABIC_REMAINS';

  return null;
}
