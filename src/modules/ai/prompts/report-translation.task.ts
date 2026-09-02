import type { AiTask } from '../ai.task';

export interface ReportTranslationResponse {
  items: Array<{ id: string; ar: string }>;
}

/**
 * Translates the leftover English in a built report into Arabic, string by
 * string, at export time.
 *
 * WHY A MODEL AND NOT MORE DICTIONARY
 *
 * `report-chrome.ts` covers the ~350 fixed labels the platform writes, and
 * `reference-names.ts` covers the vocabulary the client owns. Between them they
 * cannot cover three things, and those three are what a reader still sees in
 * English (RIO-I18N-004 §8):
 *
 *  - Narrative and code-composed prose — a methodology note explaining how a
 *    severity mean is taken is a sentence, not a label, and no lookup table can
 *    produce one.
 *  - KPI and indicator names from the Question Bank, which has no `name_ar`
 *    column at all.
 *  - Governorate and centre names — 1,554 of them, deliberately never
 *    machine-transliterated (§6), a decision the client has now reversed in
 *    favour of full Arabic.
 *
 * WHY IT IS NOT ALLOWED TO TOUCH FIGURES
 *
 * Every rule below that looks like paranoia is protecting the one guarantee the
 * whole export-time design exists for: the English and Arabic editions of one
 * approved report carry IDENTICAL figures under one approval. A model that
 * helpfully converts 3.13% to Arabic-Indic digits, rounds it, or renders it as
 * a word has broken that, and nothing downstream would notice.
 *
 * TEMPERATURE 0, and the result is cached by source string
 * (`report-translation.service.ts`), so one English string has exactly one
 * Arabic rendering across every report and every re-download. Two downloads of
 * the same official report must not differ in wording.
 */
export const REPORT_TRANSLATION_TASK: AiTask<ReportTranslationResponse> = {
  name: 'report-translation',
  promptVersion: 'report-translation-v1',
  model: 'gemini-2.5-flash',
  modelVersion: 'v1',
  // Reproducibility, not creativity. See the cache note above.
  temperature: 0,
  // Longer than the classification tasks: a batch carries a few hundred strings
  // including multi-sentence methodology notes.
  timeoutMs: 60_000,
  maxRetries: 2,
  systemPrompt: `You translate the text of an official Saudi government needs-assessment report from English into Modern Standard Arabic.

You receive a JSON array of items, each with an "id" and a "text". Return one item per input id, with the Arabic in "ar".

RULES:
1. Return EVERY id you were given, exactly once, with the same id string. Never merge, split, reorder-away or omit an item. If an item needs no change, return its text unchanged.
2. Translate into Modern Standard Arabic suitable for a government report. Formal register, no colloquialism.
3. Leave NO English in "ar". Do not add a transliteration, a gloss, or the English original in brackets.
4. NEVER change a number, percentage, decimal, ratio, currency amount, count or year. Copy every digit exactly as given, in Western digits (0-9). Do not convert to Arabic-Indic digits, do not round, do not spell a number out as a word, and do not reorder the digits of a range.
5. Copy identifiers verbatim: report codes (RPT06), indicator and question ids, version strings (v1.0), codes in brackets, URLs and email addresses.
6. PERSONAL NAMES and ORGANISATION NAMES are not translated. Return them exactly as given, in Latin script. A person's name and the name of a company, foundation or NGO are their identity, not vocabulary. If a string is a person or organisation name with nothing else in it, return it unchanged.
7. PLACE NAMES ARE DIFFERENT and MUST be translated: regions, governorates, centres and villages of Saudi Arabia have official Arabic names, and that official name is what belongs in the report. Write the standard Arabic name as Saudi authorities write it (for example Tabuk is تبوك, Al-Wajh is الوجه). Do NOT invent a phonetic re-spelling of the English transliteration when you know the real name; if you genuinely do not know a place's official Arabic name, transliterate it faithfully rather than leaving it in Latin script.
8. Preserve the structure of each string: leading and trailing punctuation, a trailing "%", a unit, an em-dash separating two halves, a "-" between two dates, and any newline. Translate the words around them.
9. A date's month name is translated; its day and year digits are not. Keep the Gregorian calendar — never convert a date to Hijri.
10. Keep it about the same length. These strings are rendered into fixed table columns and chart labels; a translation three times longer than its source will not fit.
11. Return valid JSON only.`,
  responseSchema: {
    type: 'OBJECT',
    properties: {
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' },
            ar: { type: 'STRING' },
          },
          required: ['id', 'ar'],
        },
      },
    },
    required: ['items'],
  },
};
