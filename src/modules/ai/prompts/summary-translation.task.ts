import type { AiTask } from '../ai.task';

export interface SummaryTranslationResponse {
  translations: string[];
}

const LANGUAGE_NAMES = { en: 'English', ar: 'Modern Standard Arabic' } as const;

/**
 * Translates the prose of ONE stored AI summary into the other app language,
 * in a single call — see translation/summary-localization.ts.
 *
 * The model is given a numbered list of text segments, never the summary JSON
 * itself. Keys, enum values, figures and identifiers are therefore never in
 * front of it, and the structure of the summary cannot change: each answer is
 * written back to the slot its segment came from. Position is the contract,
 * which is why the prompt insists on an exact, same-order, same-length array
 * and the caller rejects any answer that is not.
 *
 * Temperature 0 for the same reason as content-translation: re-translating
 * the same summary must give the same wording.
 */
export function buildSummaryTranslationTask(
  sourceLocale: 'en' | 'ar',
  targetLocale: 'en' | 'ar',
): AiTask<SummaryTranslationResponse> {
  const sourceName = LANGUAGE_NAMES[sourceLocale];
  const targetName = LANGUAGE_NAMES[targetLocale];
  return {
    name: `summary-translation-${sourceLocale}-${targetLocale}`,
    promptVersion: 'summary-translation-v1',
    model: 'gemini-2.5-flash',
    modelVersion: 'v1',
    temperature: 0,
    // A whole summary in one call — far longer than one content-translation
    // string, so a longer budget than that task's.
    timeoutMs: 90_000,
    maxRetries: 1,
    systemPrompt: `You are a translation assistant for a community-needs assessment platform used in Saudi Arabia. You are given a JSON array of text segments taken from ONE AI-generated assessment report summary, written in ${sourceName}. Translate every segment into ${targetName}.

RULES:
1. Return {"translations": [...]} with EXACTLY as many items as the input array, in the SAME order. Item i is the translation of input segment i. Never merge, split, drop, or reorder segments.
2. Translate the meaning faithfully. Do not add, remove, summarise, soften, or reinterpret anything. This is an official report: keep a formal register.
3. Keep every number, percentage, score, rank, date and identifier exactly as written, using Western digits (0-9).
4. Keep enumerated codes and acronyms as they are (for example HIGH, MEDIUM, LOW, KPI, SLA, RPT01).
5. Place names, organisation names and person names: use the established ${targetName} name when there is one; otherwise transliterate into ${targetName} script. Never leave a name in the source script.
6. A segment may already mix ${sourceName} with ${targetName} (for example an ${sourceName} sentence containing a ${targetName} place name). Translate the ${sourceName} parts and keep the ${targetName} parts exactly as they are.
7. If a segment is already entirely in ${targetName}, return it unchanged.

Return valid JSON only.`,
    responseSchema: {
      type: 'OBJECT',
      properties: {
        translations: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['translations'],
    },
  };
}
