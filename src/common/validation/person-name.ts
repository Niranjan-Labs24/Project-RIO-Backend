// UAT RSP-02 — a person's name as typed by a survey respondent.
//
// Letters only, Arabic or English: Arabic letters (incl. hamza forms, ة, ى and
// the extra Arabic-script letters), Arabic diacritics (tashkeel) and tatweel,
// or A–Z. Words may be joined by a single space, hyphen or apostrophe
// ("Al-Harbi", "O'Neil", "عبد الله"), and the name must start and end with a
// letter. No digits (Western or Arabic-Indic), no other symbols.
// Length 3–100 characters after trimming and collapsing repeated spaces.
// The frontend mirrors this rule in src/lib/person-name.ts.

export const PERSON_NAME_MIN_LENGTH = 3;
export const PERSON_NAME_MAX_LENGTH = 100;

const LETTER = 'A-Za-z\\u0621-\\u063A\\u0641-\\u064A\\u0671-\\u06D3\\u06FA-\\u06FC';
const MARK = '\\u064B-\\u065F\\u0670\\u0640'; // tashkeel, superscript alef, tatweel
const WORD = `[${LETTER}][${LETTER}${MARK}]*`;
const PERSON_NAME = new RegExp(`^${WORD}(?:[ '\\u2019-]${WORD})*$`);

/** The cleaned-up name (trimmed, single spaces), or null when it isn't a valid name. */
export function normalizePersonName(input: string): string | null {
  const name = input.trim().replace(/\s+/g, ' ');
  if (name.length < PERSON_NAME_MIN_LENGTH || name.length > PERSON_NAME_MAX_LENGTH) return null;
  return PERSON_NAME.test(name) ? name : null;
}
