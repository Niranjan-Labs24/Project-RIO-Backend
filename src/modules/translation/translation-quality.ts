import type { SupportedLocale } from './translation.types';

// Checks a model's translation BEFORE it is cached or persisted.
//
// Everything this module guards against has happened for real: the provider
// answering with the source text half-translated, and that half-English
// answer being cached permanently so every later view reused it. A cached
// translation is checked before the write, and again when it is read back
// (entries cached before a rule existed must not be served forever).

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

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const NUMBER_WORDS = new RegExp(
  `\\b(?:(${Object.keys(TENS).join('|')})(?:[-\\s](${Object.keys(UNITS)
    .filter((w) => UNITS[w]! > 0 && UNITS[w]! < 10)
    .join('|')}))?|(${Object.keys(UNITS).join('|')}))\\b`,
  'gi',
);

/** English number words as digits ("Sixty-five percent" → "65 percent"):
 *  a translation writing "65%" for them keeps the figure, it doesn't add one. */
function numberWordsToDigits(text: string): string {
  return text.replace(NUMBER_WORDS, (_m, tens?: string, unit?: string, single?: string) => {
    if (single) return String(UNITS[single.toLowerCase()]);
    return String(TENS[tens!.toLowerCase()]! + (unit ? UNITS[unit.toLowerCase()]! : 0));
  });
}

/** Every number in the text, as a sorted list — the multiset of figures. */
export function numericTokens(text: string): string[] {
  const matches = toWesternDigits(text).match(/\d+(?:[.,]\d+)*/g) ?? [];
  // Thousands separators differ between locales ("1,200" vs "1200"); compare
  // the digits only so a legitimate reformat is not rejected.
  return matches.map((m) => m.replace(/,/g, '')).sort();
}

/** The figures a text writes as English words ("sixty-five", "one"). */
function numberWordTokens(text: string): string[] {
  const digitsOnly = numericTokens(text);
  const withWords = numericTokens(numberWordsToDigits(text));
  return removeAll(withWords, digitsOnly);
}

/** `from` minus one occurrence of each item in `items`. */
function removeAll(from: string[], items: string[]): string[] {
  const rest = [...from];
  for (const item of items) {
    const i = rest.indexOf(item);
    if (i >= 0) rest.splice(i, 1);
  }
  return rest;
}

/**
 * Whether a translation kept the source's figures: every number written in
 * digits must still be there, and nothing new may appear — except a number
 * the source wrote as a word, which a translation may render as digits
 * ("Sixty-five percent" → "65%") or keep as a word ("one member" → "عضو واحد").
 */
function figuresKept(source: string, translated: string): boolean {
  const digits = numericTokens(source);
  const after = numericTokens(translated);
  const extra = removeAll(after, digits);
  if (after.length - extra.length !== digits.length) return false; // a digit went missing
  return removeAll(extra, numberWordTokens(source)).length === 0;
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
    // Band and status enum values are words, not acronyms: "لثقة STANDARD"
    // was cached as a finished Arabic sentence because it is all caps.
    if (w in ENUM_WORDS_AR) return true;
    const letters = w.replace(/[^A-Za-z]/g, '');
    if (letters.length < 4) return false;
    if (/\d/.test(w)) return false;
    if (w === w.toUpperCase()) return false;
    return true;
  });
}

/** All-caps values the backend writes into prose, and the Arabic the report
 *  templates use for them (frontend report-narrative-i18n.ts BAND). */
const ENUM_WORDS_AR: Record<string, string> = {
  CRITICAL: 'حرج',
  HIGH: 'عالٍ',
  MEDIUM: 'متوسط',
  LOW: 'منخفض',
  STANDARD: 'قياسي',
  MODERATE: 'معتدل',
  SEVERE: 'شديد',
  NEGLIGIBLE: 'ضئيل',
  ELEVATED: 'مرتفع',
};
const ENUM_WORDS_RE = new RegExp(`\\b(?:${Object.keys(ENUM_WORDS_AR).join('|')})\\b`, 'g');

/**
 * The model keeps enum values verbatim ("لثقة STANDARD"); swap them for their
 * Arabic label. Applied to every Arabic answer before it is checked or cached,
 * and to cached answers stored before this existed.
 */
export function localizeEnumWords(text: string, targetLocale: SupportedLocale): string {
  if (targetLocale !== 'ar') return text;
  return text.replace(ENUM_WORDS_RE, (w) => ENUM_WORDS_AR[w] ?? w);
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

  if (!figuresKept(source, translated)) return 'NUMBERS_CHANGED';

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
