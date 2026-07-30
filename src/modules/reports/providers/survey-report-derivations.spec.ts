import { describe, expect, it } from "vitest";
import type { CoverageBlock } from "../report-content.types";
import {
  UNMAPPED_DOMAIN,
  UNMAPPED_INDICATOR,
  buildComparisonBand,
  buildQuestionCoverage,
  buildResponseFunnel,
  resolveKpiDomain,
} from "./survey-report-derivations";

function coverage(over: Partial<CoverageBlock> = {}): CoverageBlock {
  return {
    studyTitle: "S",
    studyCycleNumber: 1,
    needsInStudy: 3,
    needsCoveredByThisSurvey: 1,
    surveysInStudy: 2,
    villagesCovered: 1,
    villageNames: ["V"],
    governoratesCovered: 1,
    centersCovered: 0,
    surveyQuestionsTotal: 20,
    surveyQuestionsFromBank: 18,
    surveyQuestionsCustom: 2,
    publicSurveyLinks: 2,
    activeSurveyLinks: 1,
    responsesSubmitted: 50,
    responsesValid: 40,
    responsesExcluded: 10,
    dontKnowRatePct: 12,
    duplicateResponses: 1,
    lowConfidenceResponses: 3,
    evidenceFilesTotal: 5,
    evidenceIncludedInReport: 4,
    domainsScored: 5,
    kpisAttempted: 20,
    kpisScored: 20,
    kpisNotMeasurable: 0,
    assessmentPeriod: "01 July 2026 - 15 July 2026",
    ...over,
  };
}

describe("resolveKpiDomain", () => {
  // Methodology KPIs: RollupService writes entityId === entityNameSnapshot ===
  // the KPI name, so either lookup key hits.
  const domainByKpi = new Map([["% households feeling safe in their village", "Social Protection"]]);
  const indicatorByKpi = new Map([["% households feeling safe in their village", "Perceived Safety"]]);

  it("resolves a methodology KPI by name", () => {
    expect(
      resolveKpiDomain(
        {
          entityId: "% households feeling safe in their village",
          entityNameSnapshot: "% households feeling safe in their village",
        },
        domainByKpi,
        indicatorByKpi,
      ),
    ).toEqual({ domainName: "Social Protection", indicatorName: "Perceived Safety" });
  });

  it("resolves via entityNameSnapshot when entityId is a short code", () => {
    // The case the previous entityId-only join silently failed on: seeded and
    // synthetic rollups store a code in entityId and the readable name in the
    // snapshot, while Question.kpi holds the readable name.
    expect(
      resolveKpiDomain(
        {
          entityId: "KPI_SAFETY",
          entityNameSnapshot: "% households feeling safe in their village",
        },
        domainByKpi,
        indicatorByKpi,
      ),
    ).toEqual({ domainName: "Social Protection", indicatorName: "Perceived Safety" });
  });

  it("falls back honestly when the KPI has no methodology question at all", () => {
    expect(
      resolveKpiDomain(
        { entityId: "KPI_WATER_ACCESS", entityNameSnapshot: "Daily Clean Water Access" },
        domainByKpi,
        indicatorByKpi,
      ),
    ).toEqual({ domainName: UNMAPPED_DOMAIN, indicatorName: UNMAPPED_INDICATOR });
  });

  it("never echoes the KPI name back as its own domain", () => {
    const r = resolveKpiDomain(
      { entityId: "Some KPI", entityNameSnapshot: "Some KPI" },
      domainByKpi,
      indicatorByKpi,
    );
    expect(r.domainName).not.toBe("Some KPI");
    expect(r.indicatorName).not.toBe("Some KPI");
  });
});

describe("buildResponseFunnel", () => {
  it("orders stages so drop-off reads top to bottom", () => {
    const f = buildResponseFunnel(coverage());
    expect(f.map((s) => s.stage)).toEqual([
      "Survey links issued",
      "Responses submitted",
      "Valid responses",
      "Excluded responses",
      "Duplicates flagged",
      "Low-confidence flagged",
    ]);
    expect(f[1]!.count).toBe(50);
    expect(f[2]!.count).toBe(40);
  });

  it("reconciles with the coverage counts it is derived from", () => {
    const c = coverage();
    const f = buildResponseFunnel(c);
    const submitted = f.find((s) => s.stage === "Responses submitted")!.count;
    const valid = f.find((s) => s.stage === "Valid responses")!.count;
    const excluded = f.find((s) => s.stage === "Excluded responses")!.count;
    expect(valid + excluded).toBe(submitted);
  });
});

describe("buildQuestionCoverage", () => {
  // Plots the questions THIS survey asked — not the KPIs the methodology
  // defines under each domain, which is what it used to chart under a
  // "Questions per Domain" label while the coverage tile said something else.
  it("keeps the snapshot's ordering and drops domains with no questions", () => {
    const snapshot = {
      questionsAskedByDomain: [
        { domain: "Health", domainKey: "HEALTH", count: 9 },
        { domain: "Education", domainKey: "EDUCATION", count: 5 },
        { domain: "Empty", domainKey: "EMPTY", count: 0 },
      ],
    } as never;
    expect(buildQuestionCoverage(snapshot)).toEqual([
      { domain: "Health", count: 9 },
      { domain: "Education", count: 5 },
    ]);
  });
});

describe("buildComparisonBand", () => {
  const dashboard = {
    needCount: 10,
    scoringDistribution: [
      { band: "High", count: 2 },
      { band: "Medium", count: 4 },
      { band: "Low", count: 4 },
    ],
    topPriorities: [
      { rank: 1, label: "a", domain: "Health", severityScore: 80 },
      { rank: 2, label: "b", domain: "Water", severityScore: 60 },
    ],
    trends: [],
    anomalies: [],
    reviewerNotes: [],
  };

  it("delta always equals surveyValue − orgAverage, and direction agrees", () => {
    const snapshot = {
      severity: { overallVillageNeedsIndex: 90 },
      priority: { villagePriorityScore: 40 },
    } as never;
    const rows = buildComparisonBand(snapshot, dashboard, coverage());
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.delta).toBe(r.surveyValue - r.orgAverage);
      if (r.direction === "above") expect(r.delta).toBeGreaterThan(3);
      if (r.direction === "below") expect(r.delta).toBeLessThan(-3);
      if (r.direction === "inline") expect(Math.abs(r.delta)).toBeLessThanOrEqual(3);
    }
  });

  it("omits the Needs Index row rather than comparing against a fabricated zero", () => {
    const snapshot = {
      severity: { overallVillageNeedsIndex: 90 },
      priority: { villagePriorityScore: 40 },
    } as never;
    const rows = buildComparisonBand(
      snapshot,
      { ...dashboard, topPriorities: [] },
      coverage(),
    );
    expect(rows.find((r) => r.metric.startsWith("Needs Index"))).toBeUndefined();
  });

  it("omits every row for an unscored survey with no responses", () => {
    const snapshot = {
      severity: { overallVillageNeedsIndex: null },
      priority: { villagePriorityScore: 0 },
    } as never;
    const rows = buildComparisonBand(
      snapshot,
      { ...dashboard, topPriorities: [], scoringDistribution: [] },
      coverage({ responsesSubmitted: 0, responsesValid: 0, responsesExcluded: 0 }),
    );
    expect(rows).toEqual([]);
  });
});
