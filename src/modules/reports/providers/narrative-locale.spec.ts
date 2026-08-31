import { describe, expect, it } from "vitest";
import { composeDeterministicNarrative } from "./build-unified-rpt01";
import { latinRuns } from "../../ai/language/detect-script";
import { MESSAGES } from "../../../i18n/messages";
import type { UnifiedRpt01Sections } from "../unified-report.types";

/**
 * The deterministic narrative is the one an Arabic report falls back to when
 * the model is unavailable or its cached output was rejected. Leaving it
 * English would put a paragraph of English in the most prominent part of an
 * otherwise-Arabic report, in exactly the situation where nothing downstream
 * can fix it.
 */

// Only the fields composeDeterministicNarrative actually reads. Typed through
// a cast rather than by building a whole UnifiedRpt01Sections, which would tie
// this test to fields it does not exercise.
const sections = {
  executiveSummary: {
    measuredCount: 3,
    totalNeedsExtracted: 14,
    domainsAssessed: 1,
    domainsInMethodology: 9,
    topThreeCriticalNeeds: [
      {
        rank: 1,
        indicatorName: "Textbook availability",
        domain: "Education",
        subDomain: "Access",
        severityScore: 50,
        severityBand: "HIGH",
        confidence: "LOW",
        gapType: null,
      },
    ],
  },
  needsByDomain: [{ domain: "Education", severityScore: 33.33 }],
  priorityNeeds: {
    villagePriority: {
      priorityScore: 66.67,
      priorityStatus: "MEDIUM",
      scoreDirectionNote: "ignored — the localised note is used instead",
      notCalculableReason: null,
    },
  },
  dataQualityNotes: { confidence: { flag: "LOW", reason: "Small sample." } },
} as unknown as UnifiedRpt01Sections;

describe("composeDeterministicNarrative", () => {
  it("defaults to English so existing callers are unchanged", () => {
    const out = composeDeterministicNarrative(sections);
    expect(out.executiveSummary).toContain("This survey-only assessment scored 3 of 14");
  });

  it("composes in Arabic when asked", () => {
    const out = composeDeterministicNarrative(sections, "ar");
    expect(out.executiveSummary).toContain(MESSAGES.ar["narrative.det.unassessedNote"]);
    // Figures survive translation untouched.
    expect(out.executiveSummary).toContain("3");
    expect(out.executiveSummary).toContain("14");
    expect(out.executiveSummary).toContain("66.67");
  });

  it("translates the bands it embeds, rather than leaving them English", () => {
    // An Arabic sentence carrying the English word "MEDIUM" or "LOW" is the
    // exact leak this work removes.
    const out = composeDeterministicNarrative(sections, "ar");
    expect(out.executiveSummary).toContain(MESSAGES.ar["band.priority.MEDIUM"]);
    expect(out.executiveSummary).toContain(MESSAGES.ar["band.confidence.LOW"]);
    expect(out.executiveSummary).not.toContain("MEDIUM");
    expect(out.keyFindings).toContain(MESSAGES.ar["band.severity.HIGH"]);
  });

  it("leaves reference-data names in the language the catalogue holds them", () => {
    // Domain and indicator names are the client's authoritative vocabulary and
    // are translated by nameAr columns, never invented here.
    const out = composeDeterministicNarrative(sections, "ar");
    expect(out.executiveSummary).toContain("Education");
    expect(out.keyFindings).toContain("Textbook availability");
  });

  it("carries no untranslated English prose beyond reference names and figures", () => {
    const out = composeDeterministicNarrative(sections, "ar");
    const known = new Set(["Education", "Textbook", "availability", "Access", "Small", "sample"]);
    const leaked = latinRuns(`${out.executiveSummary} ${out.keyFindings}`).filter(
      (w) => !known.has(w),
    );
    expect(leaked).toEqual([]);
  });

  it("does not print the word 'null' when a priority score is not calculable", () => {
    // The previous template literal interpolated a null reason directly, so the
    // narrative read "...is not calculable. null".
    const notCalculable = {
      ...sections,
      priorityNeeds: {
        villagePriority: {
          priorityScore: null,
          priorityStatus: "LOW",
          scoreDirectionNote: "",
          notCalculableReason: null,
        },
      },
    } as unknown as UnifiedRpt01Sections;

    for (const locale of ["en", "ar"] as const) {
      const out = composeDeterministicNarrative(notCalculable, locale);
      expect(out.executiveSummary).not.toContain("null");
    }
  });

  it("reports no findings without inventing one", () => {
    const empty = {
      ...sections,
      executiveSummary: { ...sections.executiveSummary, topThreeCriticalNeeds: [] },
    } as unknown as UnifiedRpt01Sections;
    expect(composeDeterministicNarrative(empty, "ar").keyFindings).toBe(
      MESSAGES.ar["narrative.det.noFindings"],
    );
  });
});
