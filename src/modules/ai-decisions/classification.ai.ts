import { AiService } from '../ai/ai.service';
import type { ClassificationCandidate, ClassificationResult, ClassificationSubject } from './classification.placeholder';

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
    'available domains (each with its own sub-domains), pick exactly one domain and one sub-domain from that ' +
    'list — do not invent a domain/sub-domain that is not in the list. Return valid JSON only.';

  const prompt = `Need statement: "${redactedStatement}"
Villages: ${subject.village.join(', ') || 'not specified'}
Available domains (pick domain/subDomain by their exact "name"):
${JSON.stringify(candidates)}`;

  const responseSchema = {
    type: 'object',
    properties: {
      domain: { type: 'string' },
      subDomain: { type: 'string' },
      confidence: { type: 'number' },
      rationale: { type: 'string' },
    },
    required: ['domain', 'subDomain', 'confidence', 'rationale'],
  };

  const { response } = await ai.generateJson<{
    domain: string; subDomain: string; confidence: number; rationale: string;
  }>(prompt, systemInstruction, responseSchema);

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
    confidence: response.confidence,
  };
}
