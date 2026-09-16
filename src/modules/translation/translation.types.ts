export type SupportedLocale = 'en' | 'ar';

export interface TranslateContentPayload {
  text: string;
  /** The language the caller is currently displaying the app in — the text
   * is translated INTO this language. */
  targetLocale: SupportedLocale;
  /** Optional — auto-detected from the text's own script when omitted (see
   * TranslationService.detectLocale). Pass this explicitly only when the
   * caller already knows the source language for certain (e.g. a field with
   * its own stored language tag) and detection would be unreliable (a
   * short numeric-only string, for instance). */
  sourceLocale?: SupportedLocale;
}

export interface TranslateContentResult {
  translatedText: string;
  sourceLocale: SupportedLocale;
  targetLocale: SupportedLocale;
  /** True when the text was already in the target language (or had no
   * translatable content) and was returned unchanged without calling the
   * AI provider at all. */
  unchanged: boolean;
}
