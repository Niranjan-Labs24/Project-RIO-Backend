import type { AiTask } from '../ai.task';

export interface NeedClassificationResponse {
  classified: boolean;
  domain?: string;
  subDomain?: string;
  /** 0..1. Optional on the type because a `classified: false` decline carries
   * no confidence to report — it is `required` in the response schema below
   * only for the branch that does classify, which the schema cannot express. */
  confidence?: number;
  rationale: string;
}

/**
 * Assigns a Need to exactly one configured Domain/Sub-domain.
 *
 * Temperature is 0: the same statement against the same domain list must always
 * classify the same way, and the caller persists the result as an AiDecision a
 * human then reviews. The prompt is short and the payload small, so the timeout
 * is much tighter than the report-summary tasks and two retries are affordable.
 */
export const NEED_CLASSIFICATION_TASK: AiTask<NeedClassificationResponse> = {
  name: 'need-classification',
  promptVersion: 'need-classification-v1',
  model: 'gemini-2.5-flash',
  modelVersion: 'v1',
  temperature: 0,
  timeoutMs: 20_000,
  maxRetries: 2,
  systemPrompt: `You are an NGO community-needs classification assistant. Given a need statement and a fixed list of available domains (each with its own sub-domains), decide whether the statement describes a real community need that clearly relates to one of those domains.
If it does, set classified to true and pick exactly one domain and one sub-domain from the list by their exact "name" — never invent one that is not in the list.
Whenever classified is true you MUST also return confidence as a number between 0 and 1 expressing how certain you are of that domain/sub-domain pick (1 = certain). Never omit it and never substitute a percentage out of 100.
If the statement is gibberish, empty of real content, too vague, or does not clearly relate to any listed domain, set classified to false and leave domain/subDomain out — do not guess or pick the closest-sounding domain just to fill the field.
Return valid JSON only.`,
  responseSchema: {
    type: 'OBJECT',
    properties: {
      classified: { type: 'BOOLEAN' },
      domain: { type: 'STRING' },
      subDomain: { type: 'STRING' },
      confidence: { type: 'NUMBER' },
      rationale: { type: 'STRING' },
    },
    // `confidence` is required alongside the other two. Leaving it optional
    // was what let a successful classification arrive with no confidence at
    // all, which classification.ai.ts then had to invent a value for.
    // (survey-question-recommendation.task.ts already required its own.)
    // `domain`/`subDomain` stay optional because a legitimate
    // `classified: false` decline must be able to omit them.
    required: ['classified', 'confidence', 'rationale'],
  },
};
