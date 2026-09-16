/**
 * RIO-AI-004 / Q48 — the seam for meaning-based duplicate detection.
 *
 * The client accepted embedding-based matching "as the right design" and
 * blocked the BUILD pending Q10, the AI-provider and in-Kingdom residency
 * ruling: generating an embedding means sending need text — including text
 * written by members of the public — to a third-party model.
 *
 * So the shape exists and nothing calls a provider. When Q10 clears, the work
 * is one adapter file and one config value, not a feature.
 *
 * ─── Worth raising alongside Q10 ────────────────────────────────────────────
 * The client's Technology Stack sheet offers OpenAI or self-hosted Qwen. This
 * platform's existing AI features already call Gemini
 * (src/modules/ai/ai.service.ts). Whichever way Q10 lands, that is a live
 * compliance gap independent of this ticket.
 */
export interface EmbeddingProvider {
  /** Stable identifier stored on every vector, so a model change is visible. */
  readonly modelName: string;
  /** Bumped when the prompt or preprocessing changes, forcing regeneration. */
  readonly embeddingVersion: string;
  readonly dimensions: number;
  /** True only when a real provider is configured AND approved. */
  readonly enabled: boolean;
  /**
   * One vector per input, in the same order. Batched because the candidate
   * job embeds many needs at once and per-row calls would multiply cost and
   * latency for no benefit.
   */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * The default, and the only implementation until Q10 clears.
 *
 * It does not throw. A disabled provider is the normal, expected state right
 * now, and the semantic pass checks `enabled` and skips — no error path, no
 * half-built feature reporting failures into the logs every night.
 */
export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly modelName = "none";
  readonly embeddingVersion = "none";
  readonly dimensions = 0;
  readonly enabled = false;

  embed(): Promise<number[][]> {
    // Deliberately not an error: callers branch on `enabled` first, and a
    // provider that throws would turn "not yet approved" into a broken job.
    return Promise.resolve([]);
  }
}

/**
 * Cosine similarity over two vectors of equal length, 0..1 for the
 * non-negative embeddings every current provider returns.
 *
 * Lives here rather than in the provider so the comparison is identical
 * whichever model is approved — swapping providers must not silently change
 * what "85% similar" means.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Clamp: floating-point error can put an identical pair a hair above 1,
  // which would then fail the 0..1 CHECK on duplicate_candidates.score.
  return Math.min(1, Math.max(0, similarity));
}
