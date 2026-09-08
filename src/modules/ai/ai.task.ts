import { createHash } from 'node:crypto';

/**
 * A single, self-contained AI use case: its prompt, its output contract, and
 * the model settings appropriate to it.
 *
 * Every AI feature in the platform declares one of these instead of calling the
 * model with ad-hoc arguments. That keeps three things true:
 *
 *  - Each use case gets its OWN model settings. Classifying one short need
 *    statement and writing a region-wide report summary have very different
 *    latency, determinism and context needs; they must not share one profile.
 *  - The prompt text lives in one reviewable place per use case, never inline
 *    at the call site.
 *  - `promptVersion` cannot drift from the prompt it names, because
 *    `promptHashOf` derives a fingerprint from the actual text. Persisting both
 *    means a stored output can always be traced back to the exact prompt that
 *    produced it.
 */
export interface AiTask<TResponse = unknown> {
  /** Stable identifier for logs and stored audit metadata. */
  readonly name: string;
  /** Bumped by hand when the prompt changes meaningfully. */
  readonly promptVersion: string;
  readonly systemPrompt: string;
  /**
   * Gemini model id, used only when AI_PROVIDER is `gemini`.
   *
   * On the OCI Cohere path the model comes from OCI_GENAI_MODEL_ID instead:
   * there it is a deployment choice (which tenancy, which region, on-demand
   * or a dedicated cluster) rather than something a single task decides.
   */
  readonly model: string;
  readonly modelVersion: string;
  /**
   * 0 for tasks that must be reproducible (classification, scoring-adjacent
   * work); slightly higher only where natural prose is wanted.
   */
  readonly temperature: number;
  readonly timeoutMs: number;
  /** Retries for transient upstream failures only (429/5xx/timeout). */
  readonly maxRetries: number;
  /**
   * The output contract, written in Gemini's schema dialect (upper-case type
   * names). Required for every task: without it the model is only asked for
   * JSON in prose, and malformed output is discovered at `JSON.parse` time
   * instead of being prevented.
   *
   * Gemini's dialect is the one written here because these nine schemas
   * predate the OCI move and are the reviewed, stable part of the system.
   * On the OCI Cohere path `toJsonSchema` in oci-cohere.provider.ts converts
   * them to standard JSON Schema at call time, so a task never has to know
   * which provider is configured.
   */
  readonly responseSchema: Record<string, unknown>;
  /** Phantom marker so TResponse participates in inference. */
  readonly __response?: TResponse;
}

/**
 * Fingerprint of the prompt actually sent. Store this next to `promptVersion`
 * so an edited prompt is detectable even if the version string was not bumped.
 */
export function promptHashOf(task: AiTask<unknown>): string {
  return createHash('sha256').update(task.systemPrompt).digest('hex');
}
