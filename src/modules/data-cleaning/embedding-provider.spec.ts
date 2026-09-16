import { describe, expect, it } from "vitest";
import { NullEmbeddingProvider, cosineSimilarity } from "./embedding-provider";

describe("NullEmbeddingProvider", () => {
  it("reports itself disabled rather than throwing", async () => {
    // "Not yet approved" is the normal state until Q10 clears. A provider
    // that threw would turn that into a nightly stream of job failures.
    const provider = new NullEmbeddingProvider();
    expect(provider.enabled).toBe(false);
    await expect(provider.embed()).resolves.toEqual([]);
  });
});

describe("cosineSimilarity", () => {
  it("scores an identical vector 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBe(1);
  });

  it("scores an orthogonal vector 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("ranks a near vector above a far one", () => {
    const near = cosineSimilarity([1, 2, 3], [1, 2, 3.1]);
    const far = cosineSimilarity([1, 2, 3], [3, 1, 0]);
    expect(near).toBeGreaterThan(far);
  });

  it("never exceeds 1, so the score CHECK cannot be violated", () => {
    // Floating-point error can put an identical pair a hair above 1, which
    // would fail duplicate_candidates.score's 0..1 constraint on insert.
    for (const v of [[0.1, 0.2, 0.3], [1e-8, 1e-8], [5, 5, 5]]) {
      expect(cosineSimilarity(v, [...v])).toBeLessThanOrEqual(1);
    }
  });

  it("returns 0 for empty or mismatched vectors instead of NaN", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});
