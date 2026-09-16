import type { AiTask } from '../ai.task';

export interface NeedThemeExtractionResponse {
  themes: string[];
  rationale: string;
}

/**
 * RIO-FR-003 AC 6 — extracts the recurring themes a need is about, so needs
 * can be filtered and grouped by theme.
 *
 * The themes are also what makes the methodology's "recurrence of similar
 * needs" factor computable. Counting how many needs share a theme is a much
 * weaker claim than RIO-AI-004's need-to-need merge, and it does not need it:
 * two needs sharing "distance to facility" are the same underlying problem for
 * counting purposes even if neither is a duplicate of the other.
 *
 * Two deliberate constraints, both learned from RIO-AI-001:
 *
 *  1. **Closed vocabulary.** The caller supplies the allowed themes and the
 *     model may only pick from them. Free-text themes would make the filter in
 *     AC 6 useless within a week — "water shortage", "Water Shortage" and
 *     "lack of water" would be three groups — and would silently inflate the
 *     recurrence count for whichever wording happened to be popular.
 *  2. **Temperature 0.** The same statement against the same vocabulary must
 *     produce the same themes every time, because a recurrence count that
 *     moves on re-run is not a count.
 */
export const NEED_THEME_EXTRACTION_TASK: AiTask<NeedThemeExtractionResponse> = {
  name: 'need-theme-extraction',
  promptVersion: 'need-theme-extraction-v1',
  model: 'gemini-2.5-flash',
  modelVersion: 'v1',
  temperature: 0,
  timeoutMs: 20_000,
  maxRetries: 2,
  systemPrompt: `You label a community need statement with the recurring themes it is about, choosing ONLY from a fixed list supplied with each request.

RULES:
1. Pick every theme from the supplied list that the statement genuinely describes. Match on the theme's meaning, not on shared words.
2. NEVER invent a theme, rephrase one, or return anything that is not in the supplied list verbatim.
3. Most needs carry one or two themes. Return at most three, ordered with the most central first.
4. If the statement matches nothing in the list, return an empty array. An empty result is correct and expected — do not force a weak match to avoid it.
5. Judge only what the statement says. Do not infer causes, consequences or related problems that are not stated.
6. Return valid JSON only.`,
  responseSchema: {
    type: 'OBJECT',
    properties: {
      themes: { type: 'ARRAY', items: { type: 'STRING' } },
      rationale: { type: 'STRING' },
    },
    required: ['themes', 'rationale'],
  },
};
