import type { SupportedLocale } from '../../translation/translation.types';

/**
 * The fixed sentences the summary prompts tell the model to write verbatim,
 * with the Arabic the model must write in their place when generating in
 * Arabic. One list, so a prompt can keep naming the English sentence (the
 * reviewed wording) while an Arabic run still never emits it.
 */
export const FIXED_SENTENCES_AR: ReadonlyArray<readonly [english: string, arabic: string]> = [
  ['Cycle 1 assessment — Trend Pending.', 'تقييم الدورة الأولى — الاتجاه قيد الانتظار.'],
  ['Data not available in this assessment.', 'البيانات غير متوفرة في هذا التقييم.'],
  ['Data not available in this document.', 'البيانات غير متوفرة في هذه الوثيقة.'],
  [
    'This is qualitative document-based evidence. It supports report interpretation but does not calculate, change, or replace survey-based Severity or Priority Scores.',
    'هذا دليل نوعي مستند إلى الوثائق. يدعم تفسير التقرير، لكنه لا يحسب درجات الشدة أو الأولوية المستندة إلى المسح ولا يغيّرها ولا يحلّ محلها.',
  ],
];

/**
 * Appends the output-language instruction to a summary task's system prompt.
 *
 * English returns the prompt UNCHANGED, byte for byte. Every English summary
 * already stored carries `promptHashOf` of that exact text, and the reuse
 * checks compare prompt identity — adding even an "answer in English" line
 * would make every existing summary look stale and trigger a regeneration
 * wave.
 *
 * Arabic appends a block rather than editing each prompt, so the nine
 * reviewed prompts stay the single source of the analytical rules and the
 * language rule lives in one place. The appended text changes the prompt, so
 * `promptHashOf` of an Arabic run differs from the English one and the audit
 * record shows which instruction produced a stored narrative.
 */
export function withOutputLanguage(systemPrompt: string, locale: SupportedLocale): string {
  if (locale !== 'ar') return systemPrompt;
  const fixed = FIXED_SENTENCES_AR.map(([en, ar]) => `  - "${en}" → "${ar}"`).join('\n');
  return `${systemPrompt}

OUTPUT LANGUAGE — ARABIC:
- Write EVERY narrative string value (summaries, findings, notes, explanations, recommendations, titles) in Modern Standard Arabic.
- Keep the JSON keys exactly as the schema names them. Never translate a key.
- Keep enumerated values in their canonical form exactly as they appear in the input (for example HIGH, MEDIUM, LOW, STANDARD, priority status codes, domain codes).
- Keep every number, percentage, score, identifier and date exactly as given, written with Western digits (0-9).
- Where the input gives an Arabic name for a place, domain, indicator, KPI or need (nameAr, *Ar fields, or a name already written in Arabic), use that Arabic name. Never invent a transliteration when an Arabic name is supplied.
- Where these instructions tell you to write a fixed English sentence, write its Arabic equivalent instead:
${fixed}`;
}
