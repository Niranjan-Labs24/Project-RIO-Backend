import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '../../config/config.service';
import { OciCohereEmbeddingProvider } from './oci-cohere-embedding-provider';

/**
 * RIO-AI-004 — the OCI Cohere embedding adapter.
 *
 * What matters here is not that a happy path returns numbers; it is that every
 * failure returns [] rather than a partial or reordered batch. The caller
 * pairs vectors with needs BY POSITION (see SemanticDuplicateService.
 * refreshEmbeddings), so a short or shuffled array would attach one need's
 * vector to another and propose confident nonsense. Each test below is one way
 * that could happen.
 */

function configWith(overrides: Partial<Record<string, unknown>> = {}): ConfigService {
  return {
    ociGenAiApiKey: 'sk-test',
    ociGenAiCompartmentId: 'ocid1.compartment.oc1..test',
    ociGenAiServingType: 'ON_DEMAND',
    ociGenAiEmbedModelId: 'cohere.embed-multilingual-v3.0',
    ociGenAiEmbedDimensions: 4,
    ociGenAiEmbedUrl:
      'https://inference.generativeai.me-riyadh-1.oci.oraclecloud.com/20231130/actions/embedText',
    semanticDuplicatesEnabled: true,
    ...overrides,
  } as unknown as ConfigService;
}

/** A response body of `count` vectors, each `width` wide. */
function vectors(count: number, width: number): number[][] {
  return Array.from({ length: count }, (_, i) =>
    Array.from({ length: width }, (_, j) => (i + j) / 10),
  );
}

function stubFetch(impl: (url: string, init: RequestInit) => unknown) {
  const spy = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('enabled', () => {
  it('needs the key, the compartment AND the deployment switch', () => {
    // Three gates, so three ways to be off. The compartment is in there
    // because OCI rejects a request without one — a deployment missing it
    // should read as "switched off", not fail at the wire every scan.
    expect(new OciCohereEmbeddingProvider(configWith()).enabled).toBe(true);
    expect(new OciCohereEmbeddingProvider(configWith({ ociGenAiApiKey: undefined })).enabled).toBe(
      false,
    );
    expect(
      new OciCohereEmbeddingProvider(configWith({ ociGenAiCompartmentId: undefined })).enabled,
    ).toBe(false);
    expect(
      new OciCohereEmbeddingProvider(configWith({ semanticDuplicatesEnabled: false })).enabled,
    ).toBe(false);
  });

  it('sends nothing at all while disabled', async () => {
    // Q10's whole point: the queue says "nothing was sent anywhere", and that
    // claim has to be true rather than merely intended.
    const spy = stubFetch(() => ok({ embeddings: vectors(1, 4) }));
    const provider = new OciCohereEmbeddingProvider(
      configWith({ semanticDuplicatesEnabled: false }),
    );
    await expect(provider.embed(['anything'])).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('embeddingVersion', () => {
  it('carries the model and the width, so either change regenerates', () => {
    // NeedEmbedding is unique on (needId, embeddingVersion). If this string
    // did not move with the model, vectors from two different models would sit
    // under one version and be compared to each other.
    expect(new OciCohereEmbeddingProvider(configWith()).embeddingVersion).toBe(
      'cohere.embed-multilingual-v3.0-4-v1',
    );
    expect(
      new OciCohereEmbeddingProvider(configWith({ ociGenAiEmbedDimensions: 1024 }))
        .embeddingVersion,
    ).toBe('cohere.embed-multilingual-v3.0-1024-v1');
  });

  it('fits the varchar(64) column at the real default', () => {
    const provider = new OciCohereEmbeddingProvider(configWith({ ociGenAiEmbedDimensions: 1024 }));
    expect(provider.embeddingVersion.length).toBeLessThanOrEqual(64);
  });
});

describe('embed', () => {
  it('sends the symmetric input type, not a search one', async () => {
    // A duplicate pair is two documents compared to each other. SEARCH_QUERY /
    // SEARCH_DOCUMENT are an asymmetric pair for query-to-document retrieval
    // and would place the two sides of a pair differently.
    const spy = stubFetch(() => ok({ embeddings: vectors(2, 4) }));
    await new OciCohereEmbeddingProvider(configWith()).embed(['a', 'b']);

    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.inputType).toBe('CLUSTERING');
    expect(body.truncate).toBe('END');
    expect(body.inputs).toEqual(['a', 'b']);
    expect(body.servingMode).toEqual({
      servingType: 'ON_DEMAND',
      modelId: 'cohere.embed-multilingual-v3.0',
    });
    expect(body.compartmentId).toBe('ocid1.compartment.oc1..test');
  });

  it('authenticates with a bearer token, not request signing', async () => {
    const spy = stubFetch(() => ok({ embeddings: vectors(1, 4) }));
    await new OciCohereEmbeddingProvider(configWith()).embed(['a']);

    const headers = (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
  });

  it('returns the vectors in input order', async () => {
    stubFetch(() => ok({ embeddings: vectors(3, 4) }));
    const result = await new OciCohereEmbeddingProvider(configWith()).embed(['a', 'b', 'c']);
    expect(result).toEqual(vectors(3, 4));
  });

  it('chunks above the per-request maximum and concatenates in order', async () => {
    // 96 inputs per request. 100 is two requests, and the second one's vectors
    // must land after the first one's — not merged by whichever resolved
    // first, which is why this path is sequential rather than Promise.all.
    const seen: number[] = [];
    stubFetch((_url, init) => {
      const body = JSON.parse(init.body as string) as { inputs: string[] };
      seen.push(body.inputs.length);
      // Each vector's first element is the index within its own chunk, so a
      // reordered concatenation is visible in the assertion below.
      return ok({
        embeddings: body.inputs.map((text) => [Number(text), 0, 0, 0]),
      });
    });

    const texts = Array.from({ length: 100 }, (_, i) => String(i));
    const result = await new OciCohereEmbeddingProvider(configWith()).embed(texts);

    expect(seen).toEqual([96, 4]);
    expect(result).toHaveLength(100);
    expect(result.map((v) => v[0])).toEqual(texts.map(Number));
  });

  it('returns [] when the response holds fewer vectors than inputs', async () => {
    // The misattribution case. Three needs, two vectors: taking them at face
    // value would give need C the vector for need B.
    stubFetch(() => ok({ embeddings: vectors(2, 4) }));
    await expect(
      new OciCohereEmbeddingProvider(configWith()).embed(['a', 'b', 'c']),
    ).resolves.toEqual([]);
  });

  it('returns [] when a vector is not the configured width', async () => {
    // The width is configuration, so it can be wrong. Catching it here stops a
    // misconfigured deployment filling need_embeddings with vectors nothing
    // will ever compare — the JSONB column would accept them happily.
    stubFetch(() =>
      ok({
        embeddings: [
          [1, 2, 3, 4],
          [1, 2, 3],
        ],
      }),
    );
    await expect(new OciCohereEmbeddingProvider(configWith()).embed(['a', 'b'])).resolves.toEqual(
      [],
    );
  });

  it('returns [] on an HTTP error rather than throwing', async () => {
    // The semantic pass is an addition to a queue that works without it. An
    // expired key must mean "no semantic proposals this run", not a failed scan.
    stubFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
    await expect(new OciCohereEmbeddingProvider(configWith()).embed(['a'])).resolves.toEqual([]);
  });

  it('returns [] when the request throws rather than answering', async () => {
    stubFetch(() => {
      throw new Error('socket hang up');
    });
    await expect(new OciCohereEmbeddingProvider(configWith()).embed(['a'])).resolves.toEqual([]);
  });

  it('discards an entire run when a later chunk fails', async () => {
    // Half a run is the dangerous outcome: 96 good vectors and 4 missing ones
    // still misaligns everything after the gap.
    let call = 0;
    stubFetch((_url, init) => {
      const body = JSON.parse(init.body as string) as { inputs: string[] };
      call += 1;
      return call === 1
        ? ok({ embeddings: vectors(body.inputs.length, 4) })
        : { ok: false, status: 429, json: async () => ({}) };
    });

    const texts = Array.from({ length: 100 }, (_, i) => String(i));
    await expect(new OciCohereEmbeddingProvider(configWith()).embed(texts)).resolves.toEqual([]);
  });

  it('makes no request for an empty input list', async () => {
    const spy = stubFetch(() => ok({ embeddings: [] }));
    await expect(new OciCohereEmbeddingProvider(configWith()).embed([])).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
