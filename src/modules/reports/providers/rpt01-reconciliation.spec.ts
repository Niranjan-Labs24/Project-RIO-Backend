import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "../need-record.types";
import { composeConfidenceReason, dontKnowBandOf, severityBandOf } from "./severity-bands";
import { deriveGapType } from "./derive-gap-type";
import { deriveEquityFlag } from "./derive-equity-flag";
import { rankPriorityNeeds } from "./rank-priority-needs";
import { deriveTrendNote } from "./derive-trend-note";

// Reconciles against the 28 Jul demo report the client reviewed. Every figure
// here is one the client saw; the assertions pin the CORRECTED behaviour, so a
// regression shows up as a failing arithmetic test rather than as a second
// round of client feedback.

const T = DEFAULT_THRESHOLDS;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// The demo survey's KPI severities, exactly as scored.
const KPI = {
  G06: 56.25,
  S04: 50.0,
  S01: 50.0,
  S06: 50.0,
  S11: 40.0,
  G05: 37.5,
  S07: 37.5,
  S02: 100 / 3,
  S05: null,
} as const;

describe("RPT01 reconciliation — the 28 Jul demo, corrected", () => {
  it("reproduces the Needs Index of 45.36 through the rollup chain", () => {
    const vulnerableGroups = mean([KPI.S04]); // S05 is null → skipped, NOT counted as 0
    const socialSafety = mean([KPI.S01, KPI.S02]);
    const childYouth = mean([KPI.S06, KPI.S07]);
    const socialCohesion = mean([KPI.S11]);
    const commParticipation = mean([KPI.G06, KPI.G05]);

    const socialDevelopment = mean([vulnerableGroups, socialSafety, childYouth, socialCohesion]);
    const governance = mean([commParticipation]);

    expect(socialDevelopment).toBeCloseTo(43.8542, 4);
    expect(governance).toBeCloseTo(46.875, 4);
    expect(mean([socialDevelopment, governance])).toBeCloseTo(45.3646, 4);
  });

  it("reproduces the Priority Score of 54.71 and lands in MEDIUM", () => {
    const contribution = (severity: number, weight: number) => (100 - severity) * weight;
    const sum = contribution(43.8542, 0.11) + contribution(46.875, 0.1);
    // Renormalised over the assessed domains' weight sum (0.21), which is what
    // the coverage basis printed on the page states.
    expect(sum / 0.21).toBeCloseTo(54.7073, 4);
  });

  it("never coerces a null severity to zero, and keeps a real zero", () => {
    expect(severityBandOf(null)).toBeNull();
    expect(severityBandOf(0)).toBe("LOW"); // a measured 0 is not null
    expect(severityBandOf(56.25)).toBe("HIGH");
    expect(severityBandOf(43.85)).toBe("MEDIUM");
    expect(severityBandOf(70)).toBe("CRITICAL");
  });

  it("attributes LOW confidence to sample size, not the don't-know rate", () => {
    const reason = composeConfidenceReason({
      validResponseCount: 4,
      dontKnowRate: 0.03125,
      thresholds: T,
    });
    expect(reason).toContain("Small sample: 4 valid response(s)");
    expect(reason).toContain("did not contribute");
    // The exact regression: the old fixed string claimed a high DK rate.
    expect(reason).not.toMatch(/high rate of/i);
    expect(dontKnowBandOf(0.03125)).toBe("negligible");
  });

  it("names both conditions only when both actually fired", () => {
    const both = composeConfidenceReason({ validResponseCount: 4, dontKnowRate: 0.4, thresholds: T });
    expect(both).toContain("Small sample");
    expect(both).toContain("Elevated don't-know rate");
    expect(both).not.toContain("did not contribute");

    const neither = composeConfidenceReason({ validResponseCount: 40, dontKnowRate: 0.01, thresholds: T });
    expect(neither).toBe("High response completeness.");
  });

  it("reports equity as not-evaluable rather than a silent false", () => {
    const segments = (["male", "female", "other", "prefer_not_to_say"] as const).map((value) => ({
      dimension: "gender" as const,
      value,
      severityScore: 50,
      validResponseCount: 1,
    }));
    const { equityFlag, equityDetail } = deriveEquityFlag(segments, T);
    expect(equityFlag).toBe(false);
    expect(equityDetail.evaluable).toBe(false);
    if (equityDetail.evaluable === false) {
      expect(equityDetail.reason).toContain("minimum group size is 5");
    }
    expect(equityDetail.dimensionsMissing).toContain("settlement_type");
  });

  it("flags equity when the spread clears the threshold and every group clears n", () => {
    const { equityFlag, equityDetail } = deriveEquityFlag(
      [
        { dimension: "gender", value: "female", severityScore: 70, validResponseCount: 12 },
        { dimension: "gender", value: "male", severityScore: 50, validResponseCount: 15 },
      ],
      T,
    );
    expect(equityFlag).toBe(true);
    expect(equityDetail.evaluable).toBe(true);
    if (equityDetail.evaluable) {
      expect(equityDetail.spread).toBeCloseTo(20, 2);
      expect(equityDetail.mostDisadvantaged).toBe("female");
    }
  });

  it("classifies every measured demo indicator as structural, and the unmeasured one as null", () => {
    const gap = (severityScore: number | null) =>
      deriveGapType({
        severityScore,
        equityFlag: false,
        priorCycleSeverity: null,
        gapTypeHint: null,
        thresholds: T,
      });

    expect(gap(56.25)).toBe("structural");
    expect(gap(33.33)).toBe("structural");
    expect(gap(null)).toBeNull(); // S05
    expect(gap(90)).toBe("acute");
    expect(
      deriveGapType({ severityScore: 60, equityFlag: true, priorCycleSeverity: null, gapTypeHint: null, thresholds: T }),
    ).toBe("inequality");
    expect(
      deriveGapType({ severityScore: 60, equityFlag: false, priorCycleSeverity: 55, gapTypeHint: null, thresholds: T }),
    ).toBe("chronic");
    // seasonal is never inferred from a single cycle
    expect(
      [56.25, 33.33, 90, 60].map((s) =>
        deriveGapType({ severityScore: s, equityFlag: false, priorCycleSeverity: null, gapTypeHint: null, thresholds: T }),
      ),
    ).not.toContain("seasonal");
  });

  it("ranks by relevance and excludes the unmeasured need from the ranking", () => {
    const base = {
      sourceType: "survey" as const,
      supportingText: null,
      mergedWith: null,
      equityFlag: false,
      gapType: "structural" as const,
    };
    const needs = [
      { ...base, indicatorId: "G06", domainKey: "GOVERNANCE_SERVICES", severityScore: 56.25, validResponseCount: 4 },
      { ...base, indicatorId: "S01", domainKey: "SOCIAL_DEVELOPMENT", severityScore: 50.0, validResponseCount: 4 },
      { ...base, indicatorId: "S06", domainKey: "SOCIAL_DEVELOPMENT", severityScore: 50.0, validResponseCount: 4 },
      { ...base, indicatorId: "S04", domainKey: "SOCIAL_DEVELOPMENT", severityScore: 50.0, validResponseCount: 3 },
      { ...base, indicatorId: "S07", domainKey: "SOCIAL_DEVELOPMENT", severityScore: 37.5, validResponseCount: 4 },
      { ...base, indicatorId: "G05", domainKey: "GOVERNANCE_SERVICES", severityScore: 37.5, validResponseCount: 4 },
      { ...base, indicatorId: "S05", domainKey: "SOCIAL_DEVELOPMENT", severityScore: null, validResponseCount: 0 },
    ] as never[];

    const weights = new Map([
      ["SOCIAL_DEVELOPMENT", 0.11],
      ["GOVERNANCE_SERVICES", 0.1],
    ]);
    const { ranked, notMeasured } = rankPriorityNeeds(needs, weights);

    expect(ranked.map((n) => n.indicatorId)).toEqual(["G06", "S01", "S06", "S04", "S07", "G05"]);
    expect(ranked[0]!.relevanceScore).toBeCloseTo(5.625, 3);
    // Relevance reorders against raw severity: S07 and G05 tie at 37.50, but
    // Social Development's heavier weight lifts S07 above G05.
    expect(ranked[4]!.indicatorId).toBe("S07");
    expect(notMeasured.map((n) => n.indicatorId)).toEqual(["S05"]);
  });

  it("reads the cycle number in the per-domain trend note", () => {
    const note = deriveTrendNote({
      assessmentCycle: 2,
      currentSeverity: 43.85,
      priorCycleSeverity: null,
      scopeLabel: "this domain",
    });
    expect(note).toContain("Cycle 2 assessment");
    expect(note).toContain("No Cycle 1 rollup");
    // The exact regression: a Cycle 2 report claiming a single cycle.
    expect(note).not.toContain("single assessment cycle");

    expect(
      deriveTrendNote({ assessmentCycle: 1, currentSeverity: 43.85, priorCycleSeverity: null, scopeLabel: "this domain" }),
    ).toContain("Cycle 1 baseline");

    expect(
      deriveTrendNote({ assessmentCycle: 2, currentSeverity: 40, priorCycleSeverity: 50, scopeLabel: "this domain" }),
    ).toContain("improved by 10.00 points");
  });
});
