import { describe, expect, it } from "vitest";
import { bidiRuns, containsArabic, isSimpleLine } from "./bidi";

/**
 * Strings taken from a real RPT04 Arabic export. Mixed figure/Arabic lines are
 * the whole reason this module exists.
 *
 * The invariant every test here protects: characters WITHIN a run are never
 * reordered. fontkit shapes and reverses RTL runs itself, so touching character
 * order would double-reverse and break the contextual letter forms.
 */

const joined = (s: string) => bidiRuns(s).map((r) => r.text).join("");

describe("bidiRuns", () => {
  it("returns pure-Latin text as one untouched LTR run", () => {
    // The guarantee that English PDFs cannot change.
    const en = "Domain-wise Needs Report — Education 33.33% (LOW)";
    expect(bidiRuns(en)).toEqual([{ text: en, dir: "ltr" }]);
    expect(bidiRuns("")).toEqual([{ text: "", dir: "ltr" }]);
  });

  it("returns pure-Arabic text as one RTL run, characters in logical order", () => {
    const ar = "تقرير القرية";
    // NOT reversed here — fontkit does that. Reversing would break shaping.
    expect(bidiRuns(ar)).toEqual([{ text: ar, dir: "rtl" }]);
  });

  it("splits a number out of an Arabic phrase and places it correctly", () => {
    const runs = bidiRuns("مؤشر الاحتياجات 33 من 100");
    // Visual order is reverse-logical: the trailing "100" is drawn leftmost.
    expect(runs[0]!.text.trim()).toBe("100");
    expect(runs[0]!.dir).toBe("ltr");
    expect(runs.at(-1)!.dir).toBe("rtl");
    expect(runs.at(-1)!.text).toContain("مؤشر");
  });

  it("keeps a decimal or percentage as one LTR token", () => {
    // Without number absorption these split and render as "6.14%" or "%41.6".
    const runs = bidiRuns("نسبة الاستجابة 41.6% من الإجمالي");
    const ltr = runs.filter((r) => r.dir === "ltr").map((r) => r.text.trim());
    expect(ltr).toContain("41.6%");
  });

  it("keeps a Latin reference name intact inside Arabic chrome", () => {
    // Domain names stay English until the catalogue grows nameAr, so this
    // mixed case is today's normal, not an edge case.
    const runs = bidiRuns("Education — تفاصيل المجال");
    expect(runs.some((r) => r.dir === "ltr" && r.text.includes("Education"))).toBe(true);
    expect(runs.some((r) => r.dir === "rtl" && r.text.includes("تفاصيل"))).toBe(true);
  });

  it("mirrors brackets that sit at RTL level", () => {
    const runs = bidiRuns("(متوسط)");
    const text = runs.map((r) => r.text).join("");
    // Both brackets are RTL-level here, so both flip; drawn right-to-left the
    // pair reads correctly.
    expect(text).toBe(")متوسط(");
  });

  it("places brackets so a parenthesised figure reads correctly", () => {
    // The brackets here are NEUTRAL between Arabic and a number, so UBA resolves
    // them to the paragraph direction (RTL) and they are mirrored — they do not
    // join the LTR run. What matters is the visual result, so assert that:
    // drawn left to right the line reads "(100%)" followed by the Arabic.
    const runs = bidiRuns("الذكور (100%)");
    expect(runs[0]!.text).toBe("(");
    // The number keeps its own glyphs — no mirroring inside an LTR run.
    expect(runs.some((r) => r.dir === "ltr" && r.text === "100%")).toBe(true);
    // The mirrored bracket ends the final RTL run in LOGICAL order; fontkit
    // draws that run right-to-left, so it lands at the run's visual left edge —
    // immediately after the number, which is where it belongs.
    expect(runs.at(-1)!.dir).toBe("rtl");
    expect(runs.at(-1)!.text.endsWith(")")).toBe(true);
  });

  it("never reorders characters inside a run", () => {
    for (const s of [
      "مؤشر الاحتياجات: 33 / 100 (متوسط)",
      "Education — تفاصيل المجال 33.33%",
      "القرية الأكثر تأثرًا — Al Jumum North",
    ]) {
      for (const run of bidiRuns(s)) {
        // Each run must appear verbatim in the source, modulo the deliberate
        // bracket mirroring on RTL runs.
        const unmirrored = [...run.text]
          .map((c) => ({ ")": "(", "(": ")", "]": "[", "[": "]" })[c] ?? c)
          .join("");
        expect(s.includes(run.text) || s.includes(unmirrored)).toBe(true);
      }
    }
  });

  it("loses no characters", () => {
    for (const s of [
      "مؤشر الاحتياجات: 33 / 100 (متوسط)",
      "التعليم / Water and Sanitation",
      "نسبة الاستجابة 41.6% من الإجمالي",
    ]) {
      const sorted = (x: string) => [...x].sort().join("");
      expect(sorted(joined(s))).toBe(sorted(s));
    }
  });
});

describe("isSimpleLine", () => {
  it("is true for single-direction text and false for mixed", () => {
    expect(isSimpleLine("Education 33%")).toBe(true);
    expect(isSimpleLine("تقرير القرية")).toBe(true);
    expect(isSimpleLine("مؤشر الاحتياجات 33")).toBe(false);
  });
});

describe("containsArabic", () => {
  it("distinguishes Arabic from Latin and digits", () => {
    expect(containsArabic("القرية")).toBe(true);
    expect(containsArabic("Village 42")).toBe(false);
    expect(containsArabic("Village القرية")).toBe(true);
  });
});
