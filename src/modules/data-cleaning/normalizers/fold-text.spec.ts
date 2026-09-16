import { describe, expect, it } from "vitest";
import { FOLD_FIXTURES } from "./fold-text.fixtures";
import { foldText, foldsEqual, trigramSimilarity, trigrams } from "./fold-text";

describe("foldText", () => {
  it.each(FOLD_FIXTURES)("$label", ({ input, expected }) => {
    expect(foldText(input)).toBe(expected);
  });

  it("is idempotent — folding a folded string changes nothing", () => {
    for (const { input } of FOLD_FIXTURES) {
      const once = foldText(input);
      expect(foldText(once)).toBe(once);
    }
  });

  it("uses no locale-dependent primitive", () => {
    // The whole reason this function exists in this shape is that it has a
    // twin in Postgres (rio_fold_text) backing four functional indexes. A
    // toLowerCase() or \p{...} sneaking in here is how the two silently drift.
    const source = foldText.toString();
    expect(source).not.toMatch(/toLowerCase|toLocale|\\p\{/);
  });
});

describe("foldsEqual", () => {
  it("treats Arabic spelling variants of one village as the same name", () => {
    expect(foldsEqual("المخواة", "المخواه")).toBe(true);
    expect(foldsEqual("الأحساء", "الاحساء")).toBe(true);
    expect(foldsEqual("الريـــاض", "الرياض")).toBe(true);
  });

  it("keeps genuinely different names apart", () => {
    expect(foldsEqual("الرياض", "جدة")).toBe(false);
    expect(foldsEqual("المخواة", "المذنب")).toBe(false);
  });
});

describe("trigrams", () => {
  it("pads each word the way pg_trgm does", () => {
    // pg_trgm: two leading spaces, one trailing, then 3-char windows.
    expect([...trigrams("ab")]).toEqual(["  a", " ab", "ab "]);
  });

  it("ignores empty segments", () => {
    expect(trigrams("").size).toBe(0);
    expect(trigrams(" ").size).toBe(0);
  });
});

describe("trigramSimilarity", () => {
  it("scores an identical string 1", () => {
    expect(trigramSimilarity("الرياض", "الرياض")).toBe(1);
  });

  it("scores unrelated strings 0", () => {
    expect(trigramSimilarity("الرياض", "جده")).toBe(0);
  });

  it("scores two empty strings 0, not 1", () => {
    // Otherwise every pair of blank fields sits at the top of the duplicate
    // queue claiming a perfect match.
    expect(trigramSimilarity("", "")).toBe(0);
  });

  it("ranks a near-spelling above an unrelated name", () => {
    const near = trigramSimilarity(foldText("الخالديه"), foldText("الخالدية"));
    const far = trigramSimilarity(foldText("الخالديه"), foldText("المذنب"));
    expect(near).toBeGreaterThan(far);
  });

  it("is symmetric", () => {
    const a = foldText("مركز الفرعة");
    const b = foldText("الفرعه");
    expect(trigramSimilarity(a, b)).toBe(trigramSimilarity(b, a));
  });
});
