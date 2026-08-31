import { describe, expect, it } from "vitest";
import { detectNarrativeLanguage, narrativeMatchesLocale } from "./report-summary.service";

/**
 * Verification of the model's own output. The model does not always comply,
 * most often on short or heavily numeric snapshots — which describes a lot of
 * these reports.
 */

const arabicNarrative = {
  executiveSummary:
    "قيّم هذا التقييم المبني على الاستبيان ثلاثة مؤشرات عبر مجال واحد من أصل تسعة مجالات في المنهجية، وتظل الثقة منخفضة بسبب صغر حجم العينة.",
  keyFindings: [
    {
      title: "نقص المواد التعليمية",
      // Reference data legitimately stays English until the catalogue grows
      // nameAr — this must NOT count as a language mismatch.
      domain: "Education",
      kpi: "Textbook availability",
    },
  ],
  severityBand: "HIGH",
};

const englishNarrative = {
  executiveSummary:
    "This survey-only assessment scored three indicators across one of the methodology's nine domains, and confidence remains low because of the small sample size.",
  keyFindings: [{ title: "Shortage of learning materials", domain: "Education" }],
};

describe("narrativeMatchesLocale", () => {
  it("accepts a narrative written in the requested language", () => {
    expect(narrativeMatchesLocale(arabicNarrative, "ar")).toBe(true);
    expect(narrativeMatchesLocale(englishNarrative, "en")).toBe(true);
  });

  it("rejects a narrative written in the other language", () => {
    expect(narrativeMatchesLocale(englishNarrative, "ar")).toBe(false);
    expect(narrativeMatchesLocale(arabicNarrative, "en")).toBe(false);
  });

  it("does not fail an Arabic narrative for quoting English reference names", () => {
    // The regression that would matter most in practice: every correct Arabic
    // report carries English domain and KPI names today, and flagging those
    // would burn a retry on every single generation.
    expect(narrativeMatchesLocale(arabicNarrative, "ar")).toBe(true);
  });

  it("ignores short strings, which are labels and band names rather than prose", () => {
    const bandsOnly = { severityBand: "HIGH", confidence: "LOW", priorityStatus: "MEDIUM" };
    // Nothing long enough to judge — treat as a match rather than invent a
    // failure and spend a retry on an empty narrative.
    expect(narrativeMatchesLocale(bandsOnly, "ar")).toBe(true);
    expect(narrativeMatchesLocale({}, "ar")).toBe(true);
  });

  it("reads prose nested inside arrays and objects", () => {
    const nested = {
      sections: [{ body: { text: englishNarrative.executiveSummary } }],
    };
    expect(narrativeMatchesLocale(nested, "en")).toBe(true);
    expect(narrativeMatchesLocale(nested, "ar")).toBe(false);
  });
});

describe("detectNarrativeLanguage", () => {
  it("reports what the narrative actually is, for the mismatch path", () => {
    // Stored instead of the requested locale when verification fails: recording
    // the request there would make the mismatch flag unreadable.
    expect(detectNarrativeLanguage(englishNarrative)).toBe("en");
    expect(detectNarrativeLanguage(arabicNarrative)).toBe("ar");
  });
});
