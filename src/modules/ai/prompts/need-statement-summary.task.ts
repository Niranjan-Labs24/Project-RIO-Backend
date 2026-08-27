import type { AiTask } from '../ai.task';

export interface NeedStatementSummaryResponse {
  summary: string;
  preservedFacts: string[];
  omittedForLength: boolean;
}

/**
 * Shortens ONE long Need description (RIO-AI-003).
 *
 * Scope is deliberately narrow, per the client's 25 Aug 2026 answer: the
 * structured facts — centre, village, governorate, problem title, domain — are
 * NOT the model's job. They are read from the Need record itself at display
 * time, so the model is never asked to reproduce them and therefore cannot
 * corrupt them. All this task does is rewrite the narrative shorter.
 *
 * That is also why the response carries `preservedFacts`: the AC requires the
 * summary to preserve location, need type and affected group *as they appear
 * inside the narrative*. Making the model list what it kept turns an untestable
 * prose requirement into an assertable field — see
 * need-statement-summary.facts.spec.ts, which checks the listed facts actually
 * occur in both the source and the summary rather than trusting the claim.
 *
 * Temperature 0.2 rather than 0: pure-0 summarisation of natural language
 * degrades into near-extraction (it starts copying the first N sentences).
 * Low but non-zero keeps it readable while staying close to the source. The
 * task is not scoring-adjacent, so exact reproducibility is not required —
 * `inputTextHash` plus the stored output covers auditability instead.
 */
export const NEED_STATEMENT_SUMMARY_TASK: AiTask<NeedStatementSummaryResponse> = {
  name: 'need-statement-summary',
  promptVersion: 'need-statement-summary-v1',
  model: 'gemini-2.5-flash',
  modelVersion: 'v1',
  temperature: 0.2,
  timeoutMs: 30_000,
  maxRetries: 2,
  systemPrompt: `You are a summarisation assistant for a community-needs assessment platform. You are given ONE need description written by a field researcher. Your only job is to rewrite it shorter.

WHAT YOU MUST KEEP — these are the facts the reviewer and the report depend on:
1. Every place name that appears in the text — region, governorate, centre, village, district, neighbourhood.
2. What the problem actually is (the need type), in the writer's own terms.
3. Who is affected — women, children, elderly, people with disabilities, farmers, students, households, and any stated number or proportion of them.
4. Any stated time reference — how long the problem has existed, seasonality, dates.

WHAT YOU MUST NOT DO:
1. Do not invent, estimate, round or add ANY number that is not in the source text. If the source says "many households", write "many households" — never "about 50 households".
2. Do not add a cause, a consequence, a trend, a comparison or a recommendation unless the source states it explicitly.
3. Do not add a severity, priority, score or urgency judgement of any kind. Those are computed elsewhere from survey data, never from this text.
4. Do not drop a place name, an affected group, or a stated quantity in order to make the text shorter. Cut description, repetition and background instead.
5. Do not add a title, heading, label, bullet list or closing sentence. Return continuous prose only.
6. Do not translate. Answer in the same language the source is written in.
7. Do not include personal identifiers — names of individuals, phone numbers, email addresses, ID numbers. If the source contains one, leave it out silently.

HOW TO WRITE IT:
- Neutral, factual, third person. Report what the source says; do not editorialise.
- Prefer the source's own wording for the problem. Do not upgrade "some delay" into "severe delay".
- If the source is mostly repetition, the summary may be much shorter than the limit. Do not pad.

Also return "preservedFacts": the exact substrings you kept from the source — each place name, each affected group, each quantity. Copy them character-for-character from the source; do not paraphrase them in this list.

Set "omittedForLength" to true only if you had to leave out material the reader would need. Dropping repetition or background is not an omission.

Return valid JSON only.`,
  responseSchema: {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING' },
      preservedFacts: { type: 'ARRAY', items: { type: 'STRING' } },
      omittedForLength: { type: 'BOOLEAN' },
    },
    required: ['summary', 'preservedFacts', 'omittedForLength'],
  },
};
