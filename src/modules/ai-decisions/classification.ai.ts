import { AiService } from '../ai/ai.service';
import type { ClassificationCandidate, ClassificationResult, ClassificationSubject } from './classification.placeholder';

// Thrown only when the AI genuinely ran and declined/couldn't decide (a
// vague/gibberish statement, or a hallucinated domain name outside the given
// list — see runClassification's own throw site) — as opposed to a real
// technical failure (rate-limited, upstream outage, timeout, missing config,
// zero domains configured). AiDecisionsService.runAndPersistClassification
// distinguishes the two by type, not by message-sniffing: this one becomes
// the "unclear — every Domain/Sub-domain selected" success path;
// everything else lands the Need on ai_classification_failed with a Retry.
export class AiClassificationDeclinedError extends Error {}

// Real Gemini-backed classification — same input/output shape as
// classification.placeholder.ts's classifyNeed, so AiDecisionsService can
// try this first and fall back to the placeholder without either caller or
// the AiDecision row's shape (and therefore the existing AiClassificationSection
// UI) needing to change at all.
export async function classifyNeedWithAi(
  ai: AiService,
  subject: ClassificationSubject,
  redactedStatement: string,
  candidates: ClassificationCandidate[],
): Promise<ClassificationResult> {
  const systemInstruction =
    'You are an NGO community-needs classification assistant. Given a need statement and a fixed list of ' +
    'available domains (each with its own sub-domains), decide whether the statement describes a real ' +
    'community need that clearly relates to one of those domains. ' +
    'If it does, set classified to true and pick exactly one domain and one sub-domain from the list by their ' +
    'exact "name" — never invent one that is not in the list. ' +
    'If the statement is gibberish, empty of real content, too vague, or does not clearly relate to any listed ' +
    'domain, set classified to false and leave domain/subDomain out — do not guess or pick the closest-sounding ' +
    'domain just to fill the field. Return valid JSON only.';

  const prompt = `Need statement: "${redactedStatement}"
Villages: ${subject.village.join(', ') || 'not specified'}
Available domains (pick domain/subDomain by their exact "name"):
${JSON.stringify(candidates)}`;

  const responseSchema = {
    type: 'object',
    properties: {
      classified: { type: 'boolean' },
      domain: { type: 'string' },
      subDomain: { type: 'string' },
      confidence: { type: 'number' },
      rationale: { type: 'string' },
    },
    required: ['classified', 'rationale'],
  };

  const { response } = await ai.generateJson<{
    classified: boolean;
    domain?: string;
    subDomain?: string;
    confidence?: number;
    rationale: string;
  }>(prompt, systemInstruction, responseSchema);

  // Treated as a failed classification by the caller (AiDecisionsService —
  // no fallback tier, lands on ai_classification_failed) — this is the
  // actual "AI declined to classify" signal, not the out-of-list check
  // AiDecisionsService also does, which only ever caught a hallucinated
  // name outside the given list, never a deliberate decline.
  if (!response.classified || !response.domain || !response.subDomain) {
    throw new AiClassificationDeclinedError(
      response.rationale || 'AI could not confidently classify this need into any of the available domains.',
    );
  }

  return {
    modelName: 'gemini-2.5-flash',
    modelVersion: '1.0.0',
    suggestion: {
      domains: [response.domain],
      subDomains: [response.subDomain],
      rationale: response.rationale,
      redactedStatement,
      village: subject.village.join(', '),
    },
    confidence: response.confidence ?? 0,
  };
}
