import { describe, expect, it, vi } from "vitest";
import { orgContext } from "../../tenancy/org-context";
import type { EmbeddingProvider } from "./embedding-provider";
import { SemanticDuplicateService } from "./semantic-duplicate.service";

/**
 * RIO-AI-004 — the semantic pass.
 *
 * These cover what the pass must GUARANTEE regardless of which provider Q10
 * lands on: it stays inert while disabled, it stores an AiSuggestion for every
 * proposal (AC 2), it never revisits a decided pair, and it proposes rather
 * than merges (Q11).
 *
 * Provider behaviour itself — batching, timeouts, misaligned responses — is
 * the adapter's own concern and is covered by its guard clauses returning [].
 */

const CTX = { requestId: "t", orgId: "org-1", actorId: "user-1", role: "data_analyst" };

function serviceWith(opts: {
  enabled: boolean;
  vectors?: number[][];
  existingCandidate?: { id: string; status: string } | null;
}) {
  const created = { suggestions: [] as unknown[], candidates: [] as unknown[] };
  const tx = {
    need: {
      findMany: vi.fn(async () => [
        { id: "need-a", title: "Water shortage", statement: "No reliable water" },
        { id: "need-b", title: "Unreliable water supply", statement: "Water is intermittent" },
      ]),
    },
    needEmbedding: {
      findMany: vi.fn(async ({ select }: { select: Record<string, unknown> }) =>
        // The second call (the comparison read) asks for `vector`; the first
        // (the freshness check) does not.
        "vector" in select
          ? [
              {
                needId: "need-a",
                vector: [1, 0, 0],
                need: { studyId: "study-1", mergedIntoNeedId: null },
              },
              {
                needId: "need-b",
                vector: [1, 0, 0],
                need: { studyId: "study-1", mergedIntoNeedId: null },
              },
            ]
          : [],
      ),
      upsert: vi.fn(async () => ({})),
    },
    duplicateCandidate: {
      findUnique: vi.fn(async () => opts.existingCandidate ?? null),
      update: vi.fn(async () => ({})),
      create: vi.fn(async (args: { data: unknown }) => {
        created.candidates.push(args.data);
        return {};
      }),
    },
    aiSuggestion: {
      create: vi.fn(async (args: { data: unknown }) => {
        created.suggestions.push(args.data);
        return { id: "sugg-1" };
      }),
    },
  };
  const tenant = { runAsOrg: <T>(_o: string, fn: (t: unknown) => Promise<T>) => fn(tx) };
  const context = {
    load: async () => ({ settings: { semanticDuplicateThreshold: 0.9 } }),
  };
  const provider: EmbeddingProvider = {
    modelName: "test-model",
    embeddingVersion: "test-v1",
    dimensions: 3,
    enabled: opts.enabled,
    embed: vi.fn(async () => opts.vectors ?? [[1, 0, 0], [1, 0, 0]]),
  };
  const service = new SemanticDuplicateService(
    tenant as never,
    context as never,
    provider,
  );
  return { service, tx, provider, created };
}

describe("SemanticDuplicateService", () => {
  it("does nothing at all while the provider is disabled", async () => {
    const { service, provider, tx } = serviceWith({ enabled: false });

    const result = await orgContext.run(CTX, () => service.runSemanticPass());

    expect(result).toEqual({
      embedded: 0,
      compared: 0,
      proposed: 0,
      skippedReason: "SEMANTIC_PROVIDER_DISABLED",
    });
    // The point of the env gate: no text is sent anywhere, and no query runs.
    expect(provider.embed).not.toHaveBeenCalled();
    expect(tx.need.findMany).not.toHaveBeenCalled();
  });

  it("stores an AI suggestion for every proposal — AC 2", async () => {
    const { service, created } = serviceWith({ enabled: true });

    const result = await orgContext.run(CTX, () => service.runSemanticPass());

    expect(result.proposed).toBe(1);
    expect(created.suggestions).toHaveLength(1);
    expect(created.suggestions[0]).toMatchObject({
      type: "duplicate_detection",
      modelName: "test-model",
      promptVersion: "test-v1",
      createdBy: "user-1",
    });
    // The candidate points at it, so "what proposed this pair" is answerable
    // from the row rather than inferred from the method column.
    expect(created.candidates[0]).toMatchObject({
      method: "semantic",
      aiSuggestionId: "sugg-1",
    });
  });

  it("proposes, never merges — Q11", async () => {
    const { service, created, tx } = serviceWith({ enabled: true });

    await orgContext.run(CTX, () => service.runSemanticPass());

    // A candidate row is the only write to anything a reviewer acts on: no
    // need is updated, retired or pointed at another.
    expect(created.candidates).toHaveLength(1);
    expect(tx.need.findMany).toHaveBeenCalled();
    expect(Object.keys(tx.need)).toEqual(["findMany"]);
  });

  it("never revisits a pair a human has already decided", async () => {
    const { service, tx, created } = serviceWith({
      enabled: true,
      existingCandidate: { id: "cand-1", status: "not_duplicate" },
    });

    const result = await orgContext.run(CTX, () => service.runSemanticPass());

    expect(result.proposed).toBe(0);
    expect(created.suggestions).toHaveLength(0);
    // Not even a score refresh: the pair is closed.
    expect(tx.duplicateCandidate.update).not.toHaveBeenCalled();
  });

  it("refreshes the score on a pair still awaiting review", async () => {
    const { service, tx } = serviceWith({
      enabled: true,
      existingCandidate: { id: "cand-1", status: "pending" },
    });

    await orgContext.run(CTX, () => service.runSemanticPass());

    expect(tx.duplicateCandidate.update).toHaveBeenCalled();
  });

  it("writes no vectors when the provider returns a short batch", async () => {
    // The adapter returns [] rather than throwing on any failure. Pairing a
    // vector with the wrong need would propose confident nonsense.
    const { service, tx } = serviceWith({ enabled: true, vectors: [[1, 0, 0]] });

    const result = await orgContext.run(CTX, () => service.runSemanticPass());

    expect(result.embedded).toBe(0);
    expect(tx.needEmbedding.upsert).not.toHaveBeenCalled();
  });
});
