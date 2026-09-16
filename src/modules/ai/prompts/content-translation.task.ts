import type { AiTask } from '../ai.task';

export interface ContentTranslationResponse {
  translatedText: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ar: 'Arabic',
};

/**
 * RIO Arabic Localization — Approach 3 (Hybrid), client-confirmed
 * 2026-09-08. Translates ONE piece of dynamic, user-typed content (a Need
 * title/statement, an evidence description, a decision note, a sharing
 * request's purpose, ...) between English and Arabic, on demand, the first
 * time it needs to be shown in the other language — see
 * TranslationService, which caches the result permanently afterward so
 * this only ever runs once per distinct source string.
 *
 * Deliberately separate from NEED_STATEMENT_SUMMARY_TASK, which shortens
 * text — this task must never shorten, add, or drop anything; it only
 * changes the language. Temperature 0 for the same reason every
 * scoring-adjacent task uses it here: the same source text must always
 * translate to the same wording, so a field re-viewed later (or by a
 * different user) never reads as if it silently changed.
 *
 * `sourceLocale`/`targetLocale` are baked into `buildContentTranslationTask`
 * rather than left as prompt variables, so `promptHashOf` (which fingerprints
 * `systemPrompt`) actually changes if the direction changes — useful for
 * cache/audit debugging, and it keeps the two directions as two distinct,
 * individually-reviewable prompts rather than one prompt with a runtime branch.
 */
export function buildContentTranslationTask(
  sourceLocale: 'en' | 'ar',
  targetLocale: 'en' | 'ar',
): AiTask<ContentTranslationResponse> {
  const sourceName = LANGUAGE_NAMES[sourceLocale];
  const targetName = LANGUAGE_NAMES[targetLocale];
  return {
    name: `content-translation-${sourceLocale}-${targetLocale}`,
    promptVersion: 'content-translation-v1',
    model: 'gemini-2.5-flash',
    modelVersion: 'v1',
    temperature: 0,
    timeoutMs: 20_000,
    maxRetries: 2,
    systemPrompt: `You are a translation assistant for a community-needs assessment platform used in Saudi Arabia. You are given ONE piece of user-written text in ${sourceName}. Translate it into ${targetName}.

RULES:
1. Translate the meaning faithfully. Do not add, remove, summarise, or reinterpret anything.
2. Do not add a title, heading, label, quotation marks, or any commentary. Return only the translated text itself.
3. Preserve numbers, dates, proper nouns (place names, organisation names, person names) and technical terms exactly — transliterate a proper noun if it has no established translation, never invent one.
4. Match the register of the source (a short label stays a short label; a full sentence stays a full sentence).
5. The input may be a MIX of ${sourceName} and ${targetName} (e.g. a system-generated title that already embeds a ${targetName} name inside a ${sourceName} template, such as "Individual Survey Report — Survey: <a name already in ${targetName}>"). Translate only the ${sourceName} portions into ${targetName}; leave any part already written in ${targetName} exactly as it is, in its original position, untouched.
6. If the source text is already entirely in ${targetName}, or contains no translatable content (e.g. it is only a number, a code, or punctuation), return it unchanged.

Return valid JSON only.`,
    responseSchema: {
      type: 'OBJECT',
      properties: {
        translatedText: { type: 'STRING' },
      },
      required: ['translatedText'],
    },
  };
}
