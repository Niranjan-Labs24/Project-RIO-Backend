// UAT RSP-02 — a respondent's name: letters only (Arabic or English), words
// separated by single spaces, at least 2 letters. Digits, symbols and
// Arabic-Indic digits are refused. Mirrored on the frontend in
// src/lib/person-name.ts — keep the two in step.

// Arabic letters (without the tatweel and Arabic-Indic digits), the Arabic
// short-vowel marks (harakat), and the English alphabet.
const LETTER = '[A-Za-z\\u0621-\\u063A\\u0641-\\u064A\\u0671-\\u06D3\\u064B-\\u0652]';
const NAME = new RegExp(`^${LETTER}+(?: ${LETTER}+)*$`, 'u');
const BASE_LETTER = /[A-Za-zء-غف-يٱ-ۓ]/gu;

export const PERSON_NAME_MIN_LETTERS = 2;

/** The name trimmed with single spaces, or null when it breaks the rule. */
export function normalizePersonName(input: string): string | null {
  const name = input.trim().replace(/\s+/g, ' ');
  if (!NAME.test(name)) return null;
  if ((name.match(BASE_LETTER) ?? []).length < PERSON_NAME_MIN_LETTERS) return null;
  return name;
}
