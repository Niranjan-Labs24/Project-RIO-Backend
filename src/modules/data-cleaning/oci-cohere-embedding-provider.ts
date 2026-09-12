import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import type { EmbeddingProvider } from './embedding-provider';

/**
 * RIO-AI-004 / Q48 — meaning-based duplicate detection on Cohere Embed, served
 * from OCI Generative AI in the configured region.
 *
 * ─── Why this exists alongside the Gemini adapter ───────────────────────────
 * Q10 (AI provider + in-Kingdom residency) named OCI Cohere. Embedding a need
 * means sending its title and statement — including text written by members of
 * the public — to a model; the whole point of the ruling is that the model is
 * reached in me-riyadh-1 rather than outside the Kingdom. The Gemini adapter
 * stays in the tree as the documented fallback for a broken tenancy, exactly
 * as AI_PROVIDER keeps a Gemini chat path, and DataCleaningModule picks
 * between them on that same setting.
 *
 * This is the swap `EmbeddingProvider` was designed for: one file, one config
 * value, and no change to the pass, the queue, or the stored vectors' shape.
 *
 * ─── Same key, same compartment, same host as the chat path ─────────────────
 * `OCI_GENAI_API_KEY` and `OCI_GENAI_COMPARTMENT_ID` are reused deliberately.
 * A second credential for the same tenancy would be one more thing to rotate
 * and one more way for the embedding path to be pointing somewhere the chat
 * path is not — which is precisely the residency mistake this adapter exists
 * to avoid. Auth is a plain bearer token, not OCI request signing, as in
 * oci-cohere.provider.ts.
 *
 * ─── What differs from Gemini, and why the shape of this file differs ───────
 * `embedText` takes a BATCH — up to 96 inputs in one request — where Gemini's
 * `embedContent` takes one text per call and needed a concurrency-limited
 * worker pool to stay off a rate limit. So this chunks and calls sequentially:
 * MAX_EMBEDDINGS_PER_RUN is 200, which is three requests, and three requests
 * in series finish sooner than the coordination needed to overlap them.
 *
 * ─── Model and width are configuration, not constants ───────────────────────
 * Which embedding models a tenancy serves ON_DEMAND varies by region, so both
 * are env vars and `npm run ai:oci-embed-smoke` reports what the live tenancy
 * actually answers with. The default is `cohere.embed-multilingual-v3.0` at
 * 1024 — multilingual because an Arabic need and its English twin score 0.000
 * on the literal pass, which is the entire reason the semantic pass exists.
 */

/** The subset of an embedText response this reads. */
interface EmbedTextResponse {
  embeddings?: number[][];
}

/**
 * Inputs per request. The service's own per-run ceiling is 200, so this is
 * three requests at most — but it is enforced here anyway, because a caller
 * that ever raises that ceiling must not start silently truncating.
 */
const MAX_INPUTS_PER_REQUEST = 96;

const TIMEOUT_MS = 30_000;

@Injectable()
export class OciCohereEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(OciCohereEmbeddingProvider.name);

  constructor(private readonly config: ConfigService) {}

  get modelName(): string {
    return this.config.ociGenAiEmbedModelId;
  }

  get dimensions(): number {
    return this.config.ociGenAiEmbedDimensions;
  }

  /**
   * Model and width are both in the version string, and NeedEmbedding is
   * unique on (needId, embeddingVersion) — so changing either regenerates
   * rather than silently comparing vectors from two different models. The
   * trailing v1 covers a change to the text fed to the model, which is
   * invisible in the other two.
   *
   * Stored in a varchar(64); the default reads
   * `cohere.embed-multilingual-v3.0-1024-v1` at 38 characters.
   */
  get embeddingVersion(): string {
    return `${this.modelName}-${this.dimensions}-v1`;
  }

  /**
   * Three gates, not two.
   *
   * The compartment id joins the key because OCI rejects a request without one
   * ("Compartment ID must be provided") — checking it here makes a
   * half-configured tenancy read as "semantic matching is switched off",
   * which is true and actionable, instead of a run that fails at the wire and
   * reports zero proposals for a reason nobody can see.
   */
  get enabled(): boolean {
    return (
      !!this.config.ociGenAiApiKey &&
      !!this.config.ociGenAiCompartmentId &&
      this.config.semanticDuplicatesEnabled
    );
  }

  /**
   * One vector per input, in input order.
   *
   * Returns [] — never a partial or reordered array — if ANY chunk fails. A
   * vector paired with the wrong need would propose confident nonsense, and
   * "no proposals this run" is a far better outcome than a wrong one that
   * looks authoritative. SemanticDuplicateService checks the length against
   * what it asked for and writes nothing unless they match.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.enabled || texts.length === 0) return [];

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_INPUTS_PER_REQUEST) {
      const chunk = await this.embedChunk(texts.slice(i, i + MAX_INPUTS_PER_REQUEST));
      if (!chunk) return [];
      out.push(...chunk);
    }

    // Belt and braces: embedChunk already checks its own count, so this can
    // only fire if the chunking above is wrong. Cheap, and the failure it
    // guards against is silent misattribution.
    if (out.length !== texts.length) {
      this.logger.warn(
        `Embedded ${out.length} of ${texts.length} inputs. No semantic proposals this run.`,
      );
      return [];
    }
    return out;
  }

  private async embedChunk(texts: string[]): Promise<number[][] | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(this.config.ociGenAiEmbedUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.ociGenAiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          compartmentId: this.config.ociGenAiCompartmentId,
          servingMode: {
            servingType: this.config.ociGenAiServingType,
            modelId: this.modelName,
          },
          inputs: texts,
          // Cohere's v3 embedding models place a vector differently depending
          // on the job it is for, and the choice is not cosmetic: SEARCH_QUERY
          // and SEARCH_DOCUMENT are an ASYMMETRIC pair, meant for matching a
          // short query against a long document. A duplicate pair is two needs
          // of the same kind compared to each other, which is the symmetric
          // case CLUSTERING is for — the same reasoning that put
          // SEMANTIC_SIMILARITY rather than RETRIEVAL_* on the Gemini adapter.
          inputType: 'CLUSTERING',
          // A need statement can run long. Truncating the tail is better than
          // a 400 that loses the whole batch — and the title, which carries
          // most of the duplicate signal, is at the front of the text.
          truncate: 'END',
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Never throws. The semantic pass is an addition to a queue that
        // already works without it; a provider outage, an expired key or a
        // missing IAM policy must degrade to "no semantic proposals this
        // run", not fail the scan.
        //
        // OCI answers an unauthorized caller with 404 rather than 403, so a
        // 404 here is far more likely to be the policy than a wrong URL —
        // said out loud because the first person to read this log will
        // otherwise go looking for a typo in the endpoint.
        this.logger.warn(
          `Embedding request failed with status ${res.status}` +
            `${res.status === 404 ? ' (OCI answers an unauthorized caller with 404 — check the IAM policy on the compartment before the URL)' : ''}` +
            '. No semantic proposals this run.',
        );
        return null;
      }

      const data = (await res.json()) as EmbedTextResponse;
      const vectors = data.embeddings;
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        this.logger.warn(
          `Embedding returned ${vectors?.length ?? 0} vectors for ${texts.length} inputs.`,
        );
        return null;
      }

      // Width is configuration here rather than a constant, so it can be
      // wrong. Catching it at the boundary keeps a misconfigured deployment
      // from filling need_embeddings with vectors that nothing will ever
      // compare — the JSONB column would take them happily.
      const wrong = vectors.find((v) => !Array.isArray(v) || v.length !== this.dimensions);
      if (wrong) {
        this.logger.warn(
          `Embedding returned ${Array.isArray(wrong) ? wrong.length : 0} dimensions, ` +
            `expected ${this.dimensions}. Check OCI_GENAI_EMBED_DIMENSIONS against ` +
            `${this.modelName} — run \`npm run ai:oci-embed-smoke\` to see what it returns.`,
        );
        return null;
      }

      return vectors;
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
