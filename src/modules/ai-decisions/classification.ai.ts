import { AiService } from '../ai/ai.service';
import { NEED_CLASSIFICATION_TASK } from '../ai/prompts/need-classification.task';
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
  const prompt = `Need statement: "${redactedStatement}"
Villages: ${subject.village.join(', ') || 'not specified'}
Available domains (pick domain/subDomain by their exact "name"):
${JSON.stringify(candidates)}`;

  const { response } = await ai.run(NEED_CLASSIFICATION_TASK, prompt);

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
    // Recorded from the task itself so the stored decision always names the
    // model that actually ran.
    modelName: NEED_CLASSIFICATION_TASK.model,
    modelVersion: NEED_CLASSIFICATION_TASK.modelVersion,
    suggestion: {
      domains: [response.domain],
      subDomains: [response.subDomain],
      rationale: response.rationale,
      redactedStatement,
      village: subject.village.join(', '),
    },
    // NOT `?? 0`. Zero is a real, distinct value on this column — the
    // "AI declined to classify" path stores it to mean "no confidence at
    // all" — so coercing an unreported confidence to 0 made a perfectly
    // good classification render as the worst possible one, in red, at 0%.
    // `null` means "not reported"; the reviewer UI flags that for closer
    // review instead of showing a fabricated number. NEED_CLASSIFICATION_TASK
    // now lists confidence as required, so this should be rare.
    confidence: typeof response.confidence === 'number' && Number.isFinite(response.confidence)
      ? response.confidence
      : null,
  };
}
