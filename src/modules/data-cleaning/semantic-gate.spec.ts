import { describe, expect, it } from "vitest";
import { gatePair, statedYears, type PairCandidate } from "./semantic-duplicate.service";

/**
 * RIO-AI-004 — the structural gate that runs before any vector is compared.
 *
 * Every case here comes from a score MEASURED against the real model, not from
 * a guess about what embeddings might do. The two false positives the gate
 * exists to remove were both observed:
 *
 *   "Education gap" vs "Water supply on school"            0.818
 *   same need, 2026 vs 2025                                0.983
 *
 * The second is the important one: it scores ABOVE most genuine duplicates
 * (0.923-0.985), so no threshold in either direction separates it.
 */

const need = (over: Partial<PairCandidate> = {}): PairCandidate => ({
  needId: "n1",
  studyId: "s1",
  domain: null,
  subDomain: null,
  text: "",
  vector: [],
  ...over,
});

describe("statedYears", () => {
  it("finds four-digit years in either script", () => {
    expect([...statedYears("Risk of dropouts in academic year 2026")]).toEqual(["2026"]);
    expect([...statedYears("خطر التسرب المدرسي في العام الدراسي 2026")]).toEqual(["2026"]);
  });

  it("ignores numbers that are not plausibly years", () => {
    // A bare 1200 is far more likely a population, a distance or a budget.
    // Treating it as a year would block genuine duplicates.
    expect(statedYears("1200 households affected").size).toBe(0);
    expect(statedYears("Distance is 500 metres").size).toBe(0);
    expect(statedYears("Budget of 45000 SAR").size).toBe(0);
  });
});

describe("gatePair — domain", () => {
  it("blocks two needs in different domains", () => {
    // The 0.818 pair. Embeddings of community needs sit in a narrow band
    // because they are all community needs; a threshold cannot fix this.
    const result = gatePair(
      need({ domain: "Education", text: "Education gap" }),
      need({ domain: "Water", text: "Water supply on school" }),
    );
    expect(result).toEqual({ ok: false, reason: "DIFFERENT_DOMAIN" });
  });

  it("allows two needs in the same domain", () => {
    expect(
      gatePair(need({ domain: "Health" }), need({ domain: "Health" })).ok,
    ).toBe(true);
  });

  it("fails OPEN when either need is unclassified", () => {
    // A missing domain is not evidence of difference. Blocking on it would
    // hide duplicates rather than prevent false ones.
    expect(gatePair(need({ domain: null }), need({ domain: "Health" })).ok).toBe(true);
    expect(gatePair(need({ domain: "Health" }), need({ domain: null })).ok).toBe(true);
    expect(gatePair(need(), need()).ok).toBe(true);
  });

  it("blocks on sub-domain when the domains agree", () => {
    const result = gatePair(
      need({ domain: "Health", subDomain: "Maternal" }),
      need({ domain: "Health", subDomain: "Dental" }),
    );
    expect(result).toEqual({ ok: false, reason: "DIFFERENT_SUB_DOMAIN" });
  });
});

describe("gatePair — period", () => {
  it("blocks the same need stated for two different years", () => {
    // 0.983 semantically — above most real duplicates. This gate is the only
    // thing that separates it.
    const result = gatePair(
      need({ text: "Risk of edu dropouts in academic year 2026" }),
      need({ text: "Risk of edu dropouts in academic year 2025" }),
    );
    expect(result).toEqual({ ok: false, reason: "DIFFERENT_PERIOD" });
  });

  it("allows a pair that shares a year even when each names several", () => {
    expect(
      gatePair(
        need({ text: "Dropouts across 2025 and 2026" }),
        need({ text: "Dropout risk in the 2026 academic year" }),
      ).ok,
    ).toBe(true);
  });

  it("fails OPEN when either need states no year", () => {
    expect(
      gatePair(
        need({ text: "Risk of edu dropouts in academic year 2026" }),
        need({ text: "Dropout risk in the academic year" }),
      ).ok,
    ).toBe(true);
  });

  it("does not block the cross-language pair this feature exists for", () => {
    // Literal similarity here is 0.000 — different scripts share no trigrams.
    // A word-based prefilter would have excluded exactly this pair, which is
    // why the cheap first filter is structural rather than textual.
    expect(
      gatePair(
        need({ domain: "Health", text: "No health clinic in the settlement" }),
        need({ domain: "Health", text: "لا توجد عيادة صحية في المنطقة" }),
      ).ok,
    ).toBe(true);
  });
});
