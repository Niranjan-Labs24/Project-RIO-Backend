import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "../../config/config.service";
import type { EmbeddingProvider } from "./embedding-provider";

/**
 * RIO-AI-004 / Q48 — meaning-based duplicate detection, on the provider this
 * platform already uses.
 *
 * ─── Why Gemini, and what that does and does not settle ─────────────────────
 * Q10 (AI provider + in-Kingdom residency) is still unanswered. The decision
 * taken here is to wire the provider the codebase ALREADY calls for AI
 * classification and need summarisation (src/modules/ai/ai.service.ts) rather
 * than wait, so the feature is complete and testable now. If the client names
 * a different provider, `EmbeddingProvider` is the seam: one new file, no
 * change to the pass, the queue, or the stored vectors' shape.
 *
 * That is a build decision, NOT a residency ruling. Embedding a need means
 * sending its text — including text written by members of the public — to a
 * third-party model outside the Kingdom. So this provider reports `enabled`
 * only when BOTH are true:
 *
 *   1. GEMINI_API_KEY is configured, and
 *   2. SEMANTIC_DUPLICATES_ENABLED is explicitly set.
 *
 * The second gate is an environment variable rather than a screen toggle on
 * purpose. Starting to send citizen-entered text to an external API is a
 * deployment decision made once, with whoever owns the data-protection
 * question in the room — not a switch a reviewer can flip mid-shift.
 *
 * ─── Model and endpoint, verified against the live API ──────────────────────
 * `gemini-embedding-001` with `:embedContent`. Checked against this project's
 * own key rather than assumed: ListModels offers exactly three embedding
 * models, none of them text-embedding-004, and their supported methods are
 * `embedContent` and `asyncBatchEmbedContent` — there is NO
 * `batchEmbedContents`, which an earlier cut of this file used and which
 * returned 404 for every request.
 *
 * `asyncBatchEmbedContent` is a job-submission API with polling and its own
 * failure modes. For the volumes here — at most a couple of hundred needs per
 * run, most already embedded — concurrency-limited single calls are simpler
 * and finish sooner than a batch job round trip.
 */

/** The subset of an embedContent response this reads. */
interface EmbedContentResponse {
  embedding?: { values?: number[] };
}

const MODEL = "gemini-embedding-001";

// gemini-embedding-001 returns 3072 dimensions by default and supports
// truncation to a smaller size. 768 is requested deliberately: it is a
// supported size, it is a quarter of the storage in a JSONB column, and it is
// four times faster to compare while the vectors live in JSON rather than
// pgvector. Cosine normalises by magnitude, so truncation does not distort the
// comparison.
const DIMENSIONS = 768;

// Bumped whenever the model, the dimensions or the text we feed it changes.
// NeedEmbedding is unique on (needId, embeddingVersion), so a bump regenerates
// rather than silently comparing vectors from two different models.
const EMBEDDING_VERSION = "gemini-embedding-001-768-v1";

// How many requests are in flight at once. The API is per-request here, and an
// unbounded Promise.all over 200 needs is a self-inflicted rate limit.
const CONCURRENCY = 8;
const TIMEOUT_MS = 30_000;

@Injectable()
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(GeminiEmbeddingProvider.name);

  readonly modelName = MODEL;
  readonly embeddingVersion = EMBEDDING_VERSION;
  readonly dimensions = DIMENSIONS;

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return !!this.config.geminiApiKey && this.config.semanticDuplicatesEnabled;
  }

  /**
   * One vector per input, in input order.
   *
   * Returns [] — never a partial or reordered array — if ANY input fails. A
   * vector paired with the wrong need would propose confident nonsense, and
   * "no proposals this run" is a far better outcome than a wrong one that
   * looks authoritative.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.enabled || texts.length === 0) return [];

    const out: (number[] | null)[] = new Array(texts.length).fill(null);
    let cursor = 0;
    let failed = false;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= texts.length || failed) return;
        const vector = await this.embedOne(texts[index]!);
        if (!vector) {
          failed = true;
          return;
        }
        out[index] = vector;
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, texts.length) }, () => worker()),
    );

    if (failed || out.some((v) => v === null)) return [];
    return out as number[][];
  }

  private async embedOne(text: string): Promise<number[] | null> {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent` +
      `?key=${this.config.geminiApiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${MODEL}`,
          content: { parts: [{ text }] },
          // The task type the model optimises the vector for. This one asks
          // "are these two texts about the same thing", which is exactly the
          // question a duplicate pair poses — as opposed to the query-to-
          // document framing of retrieval.
          taskType: "SEMANTIC_SIMILARITY",
          outputDimensionality: DIMENSIONS,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Never throws. The semantic pass is an addition to a queue that
        // already works without it; a provider outage must degrade to "no
        // semantic proposals this run", not fail the scan.
        this.logger.warn(
          `Embedding request failed with status ${res.status}. No semantic proposals this run.`,
        );
        return null;
      }

      const data = (await res.json()) as EmbedContentResponse;
      const values = data.embedding?.values;
      if (!values || values.length !== DIMENSIONS) {
        this.logger.warn(
          `Embedding returned ${values?.length ?? 0} dimensions, expected ${DIMENSIONS}.`,
        );
        return null;
      }
      return values;
    } catch (error) {
      this.logger.warn(
        `Embedding request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
