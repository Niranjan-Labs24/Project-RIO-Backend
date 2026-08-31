import { DEFAULT_APP_LOCALE, type AppLocale } from '../../../i18n/locale';
import { translate } from '../../../i18n/translate';

/**
 * The output-language contract shared by every report-narrative prompt.
 *
 * TWO HALVES, AND THE SPLIT MATTERS
 *
 * `LANGUAGE_RULE` is appended to each system prompt and is byte-identical on
 * every call. `promptHashOf` (ai.task.ts) hashes only the system prompt, so a
 * rule that varied per locale would give one task a different hash per request
 * and destroy the audit trail that hash exists to provide. The hash changes
 * exactly once — when the rule is added — and each `promptVersion` is bumped by
 * hand alongside it, as the convention requires.
 *
 * `languageDirective()` carries the per-call VALUES in the user turn: which
 * language to write, and the exact fixed phrases the prompt tells the model to
 * emit verbatim.
 *
 * WHY THE FIXED PHRASES MOVED OUT OF THE PROMPTS
 *
 * Eight system prompts used to hardcode English sentences the model was ordered
 * to reproduce exactly — "Cycle 1 assessment — Trend Pending.", "Data not
 * available in this assessment." That is the subtlest leak in the whole
 * effort: the prompt correctly says "write Arabic", and then hands the model an
 * English sentence to copy. Supplying them per-locale from the message
 * catalogue fixes it without touching the static rule.
 *
 * WHAT IS DELIBERATELY NOT TRANSLATED BY THE MODEL
 *
 * Bands, confidence reasons, domain names and figures reach the model already
 * in the report's language (or, for reference data, still in English until the
 * catalogue grows `nameAr`). The model must copy them, never translate them —
 * a model that rewrites a supplied band is how a 3.13% don't-know rate once
 * became the word "high". See RIO-I18N-003 §6.
 */
export const LANGUAGE_RULE = `

LANGUAGE:
Write every narrative field of your response in the language named by \`outputLanguage\` in the input — "ar" means Modern Standard Arabic, "en" means English. Write in that language even when parts of the supplied data are in a different one.
Do not mix languages within a sentence, and do not add a translation, transliteration or gloss of your own.
Values supplied to you in the input — band names, confidence reasons, domain, sub-domain, indicator, KPI, village, governorate and centre names, and every figure — are NOT yours to translate. Reproduce them exactly as given, in the language they are given in. If a supplied name is in a different language from \`outputLanguage\`, that is deliberate; leave it alone.
Where this prompt tells you to write a fixed sentence, use the exact string supplied for it in the input rather than composing your own wording.
Also return \`detectedLanguage\`: the language of the SOURCE data you were given, as "ar" or "en".`;

/**
 * The per-call language block, prepended to the user turn.
 *
 * Kept as a labelled block rather than interleaved with the data so the model
 * reads the instruction before the JSON, and so a reader of a stored prompt can
 * see at a glance which language edition it produced.
 */
export function languageDirective(locale: AppLocale = DEFAULT_APP_LOCALE): string {
  return [
    `outputLanguage: ${locale}`,
    `TREND_PENDING_TEXT: ${translate(locale, 'narrative.cycle1TrendPending')}`,
    `DATA_UNAVAILABLE_TEXT: ${translate(locale, 'narrative.dataNotAvailable')}`,
    `DOCUMENT_DATA_UNAVAILABLE_TEXT: ${translate(locale, 'narrative.dataNotAvailableInDocument')}`,
    '',
  ].join('\n');
}

/**
 * `detectedLanguage`, for a task's `responseSchema`.
 *
 * Optional on purpose — never added to `required`. A response stored before
 * this field existed must stay parseable, and the field is a cross-check
 * against `detectLanguage()` rather than a source of truth: a model reporting
 * the language of its own output is the least reliable available source for it.
 */
export const DETECTED_LANGUAGE_PROPERTY = {
  detectedLanguage: { type: 'STRING', enum: ['ar', 'en'] },
} as const;
