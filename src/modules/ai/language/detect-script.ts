/**
 * Which script a piece of free text is dominantly written in.
 *
 * Arabic and Latin occupy disjoint Unicode blocks, so across the two languages
 * this platform supports, script detection is close to exact and needs no
 * model, no network call and no tokens. That matters for three reasons:
 *
 *  1. It is deterministic and unit-testable — a fixture set pins the behaviour,
 *     which a model-reported language never could.
 *  2. It is known BEFORE the model runs, so a failed generation can still be
 *     retried in the right language.
 *  3. It is not self-reported. A model stating the language of its own output
 *     is the least reliable available source for that fact.
 *
 * Note what this does NOT decide: the output language of an AI task. That
 * follows the application locale (RIO-I18N-003 §0). This function labels the
 * SOURCE, verifies that generated text came back in the language that was
 * asked for, and backfills existing rows.
 */

// Arabic (0600–06FF), Arabic Supplement (0750–077F), Arabic Extended-A
// (08A0–08FF), and the two presentation-forms blocks (FB50–FDFF, FE70–FEFF)
// that text pasted from older Windows tooling still arrives in.
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/u;
const LETTER = /\p{L}/u;

export type ContentLanguage = 'ar' | 'en';

/**
 * Dominant script of `text`.
 *
 * A THRESHOLD, not a majority. A field researcher's Arabic statement routinely
 * carries English domain terms, an organisation name, or a transliterated place
 * name; at a 50% cut those statements flip to English on a few borrowed words.
 * 0.3 says "if nearly a third of the letters are Arabic, this is Arabic text
 * with borrowings in it", which is what the real data looks like.
 *
 * Digits and punctuation are ignored entirely — they are shared between the two
 * scripts and a heavily numeric statement would otherwise be unclassifiable.
 * Text with no letters at all returns 'en', matching DEFAULT_APP_LOCALE:
 * there is nothing to detect, so the answer is the default rather than a guess.
 */
export function detectLanguage(text: string, threshold = 0.3): ContentLanguage {
  let letters = 0;
  let arabic = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    letters++;
    if (ARABIC.test(ch)) arabic++;
  }
  if (letters === 0) return 'en';
  return arabic / letters >= threshold ? 'ar' : 'en';
}

/** Whether `text` contains any Arabic letter at all. Cheaper than a full count
 *  and the right question for "does this string need RTL treatment". */
export function containsArabic(text: string): boolean {
  return ARABIC.test(text);
}

/**
 * Runs of Latin-script letters in `text` — the check behind the "no English
 * anywhere" guarantee on an Arabic report.
 *
 * Returns the offending runs rather than a boolean so a caller can report WHAT
 * leaked, which is the difference between an actionable warning and an
 * unfalsifiable one. Digits, punctuation and whitespace are not Latin *letters*
 * and never appear here — Western digits inside Arabic text are a formatting
 * decision (still open with the client), not a translation failure.
 *
 * `minLength` exists because single stray Latin letters are almost always unit
 * symbols or list markers rather than untranslated prose; the default of 2
 * keeps the signal honest.
 */
export function latinRuns(text: string, minLength = 2): string[] {
  const runs = text.match(/[A-Za-z]+/g) ?? [];
  return runs.filter((run) => run.length >= minLength);
}
