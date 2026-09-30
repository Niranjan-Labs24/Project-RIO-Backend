/**
 * Pulls the number out of a numeric question's answer.
 *
 * A numeric question reaches the respondent as a plain text box — the public
 * survey contract maps every answer type it has no widget for onto `text`
 * (see CitizenService.mapAnswerTypeForCitizen) — so real answers to "on how
 * many days..." arrive as "3", "5 days" and "3d" side by side. `Number()`
 * returns NaN for all but the first, and dropping those made a question
 * answered 3 and 5 report an average of 3 from a single response, which
 * reads as agreement rather than as half the data missing.
 *
 * Rules, in order:
 *  - Arabic-Indic digits fold to ASCII. This is a bilingual product whose
 *    respondents type in Arabic; ٥ is the same answer as 5.
 *  - A comma used as a digit-group separator ("2,500") is removed, but only
 *    in the unambiguous 1,234 / 12,345,678 shape, matched in one pass over
 *    the whole grouped number. A bare "2,5" is left alone rather than
 *    guessed at — reading it as 25 or as 2.5 would both invent a value.
 *  - The FIRST number wins, so "3-5 days" is 3 and "about 4" is 4. A range
 *    has no single right answer, and taking the low end never overstates.
 *
 * Returns null when there is no number at all ("don't know", ""), which
 * keeps those out of the statistics exactly as before.
 *
 * Mirrored on the frontend as parseNumericAnswer in
 * src/lib/survey-response-stats.ts — the two repos share no code, and the
 * same answers are summarised on both sides.
 */
export function parseNumericAnswer(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const ascii = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\d{1,3}(?:[,٬]\d{3})+(?!\d)/g, (grouped) => grouped.replace(/[,٬]/g, ''));
  const match = /-?\d+(?:[.٫]\d+)?/.exec(ascii);
  if (!match) return null;
  const value = Number(match[0].replace('٫', '.'));
  return Number.isFinite(value) ? value : null;
}
