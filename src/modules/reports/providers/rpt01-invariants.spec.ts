import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, type NeedRecord, type UnitGeo } from "../need-record.types";
import { buildNeedRecords, surveyNeedId, type ClassificationRow, type KpiRollupRow } from "./build-need-records";
import { buildNeedHierarchy } from "./build-need-hierarchy";
import { composeExecutiveSummary } from "./compose-executive-summary";
import { composePatternAnalysis } from "./compose-pattern-analysis";
import { composeDataQualityNotes } from "./compose-data-quality-notes";
import { rankPriorityNeeds } from "./rank-priority-needs";

const T = DEFAULT_THRESHOLDS;

const GEO: UnitGeo = {
  regionId: null,
  regionName: "Al-Qassim",
  governorateIds: [],
  governorateNames: ["Al-Badai"],
  centerIds: [],
  centerNames: [],
  villages: ["Village A"],
  scopeLabel: "Al-Badai, Al-Qassim — all 1 village(s) (consolidated)",
};

const SOURCE_REF_BASE = {
  kind: "survey_rollup" as const,
  surveyId: "srv-1",
  surveyTitle: "Baseline Household Survey",
  studyId: "study-1",
  rollupLevel: "KPI" as const,
  methodologyVersionId: "mv-1",
  methodologyVersionLabel: "v1.0",
  snapshotId: "snap-1",
  assessmentCycle: 1,
  calculatedAt: "2026-07-22T09:00:00Z",
};

function kpi(entityId: string, severityScore: number | null, over: Partial<KpiRollupRow> = {}): KpiRollupRow {
  return {
    entityId,
    entityNameSnapshot: `${entityId} KPI`,
    severityScore,
    confidenceLevel: "LOW",
    validResponseCount: severityScore === null ? 0 : 4,
    excludedResponseCount: severityScore === null ? 4 : 0,
    dontKnowCount: 0,
    notApplicableCount: 0,
    dontKnowRate: 0.0313,
    ...over,
  };
}

function classification(entityId: string, domain: string, subDomain: string): ClassificationRow {
  return {
    domain,
    domainKey: domain.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    subDomain,
    subDomainKey: subDomain.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    indicatorId: `${entityId} Indicator`,
    indicatorName: `${entityId} Indicator`,
    gapTypeHint: null,
  };
}

function records(): NeedRecord[] {
  const kpiRollups = [kpi("S04", 50), kpi("S05", null), kpi("G06", 56.25)];
  return buildNeedRecords({
    kpiRollups,
    classificationByIndicator: new Map([
      ["S04", classification("S04", "Social Development", "Vulnerable Groups")],
      ["S05", classification("S05", "Social Development", "Vulnerable Groups")],
      ["G06", classification("G06", "Governance Services", "Community Participation")],
    ]),
    segmentsByIndicator: new Map(),
    priorCycleByIndicator: new Map(),
    unitGeo: GEO,
    sourceRefBase: SOURCE_REF_BASE,
    thresholds: T,
    surveyId: "srv-1",
    villageScope: "",
  });
}

describe("NeedRecord invariants", () => {
  it("a survey record never carries supportingText or mergedWith", () => {
    for (const n of records()) {
      expect(n.sourceType).toBe("survey");
      expect(n.supportingText).toBeNull();
      expect(n.mergedWith).toBeNull();
    }
  });

  it("a null severity always carries a reason, and a measured one never does", () => {
    for (const n of records()) {
      if (n.severityScore === null) expect(n.notMeasuredReason).toBeTruthy();
      else expect(n.notMeasuredReason).toBeNull();
    }
  });

  it("sourceRef is present on every record and names its own rollup entity", () => {
    for (const n of records()) {
      expect(n.sourceRef).toBeTruthy();
      expect(n.sourceRef.rollupEntityId).toBe(n.kpiCode);
      expect(n.sourceRef.snapshotId).toBe("snap-1");
    }
  });

  it("needId is deterministic across regenerations of the same scored data", () => {
    expect(records().map((n) => n.needId)).toEqual(records().map((n) => n.needId));
    expect(surveyNeedId("srv-1", "S04", "")).toBe(surveyNeedId("srv-1", "S04", ""));
    // …and distinct per survey, so the Merged Report cannot collide two sources.
    expect(surveyNeedId("srv-1", "S04", "")).not.toBe(surveyNeedId("srv-2", "S04", ""));
  });

  it("explains a null severity from the rollup's own status counts, not a guess", () => {
    const [s05] = buildNeedRecords({
      kpiRollups: [kpi("S05", null, { excludedResponseCount: 4, dontKnowCount: 0 })],
      classificationByIndicator: new Map([["S05", classification("S05", "Social Development", "Vulnerable Groups")]]),
      segmentsByIndicator: new Map(),
      priorCycleByIndicator: new Map(),
      unitGeo: GEO,
      sourceRefBase: SOURCE_REF_BASE,
      thresholds: T,
      surveyId: "srv-1",
      villageScope: "",
    });
    expect(s05!.notMeasuredReason).toContain("0 valid responses");
    // 4 excluded, 0 don't-knows — the note must not invent a don't-know cause.
    expect(s05!.notMeasuredReason).toContain("excluded for another reason");
    expect(s05!.notMeasuredReason).not.toContain("don't-know");
  });
});

describe("Section self-consistency", () => {
  it("the hierarchy holds exactly the flat need records, none dropped", () => {
    const needRecords = records();
    const hierarchy = buildNeedHierarchy({
      needRecords,
      domainMetaByKey: new Map(),
      subDomainByKey: new Map(),
      indicatorByKey: new Map(),
      assessmentCycle: 1,
    });
    const nested = hierarchy.flatMap((d) => d.subDomains.flatMap((s) => s.indicators.flatMap((i) => i.needs)));
    expect(nested).toHaveLength(needRecords.length);
    expect(new Set(nested.map((n) => n.needId))).toEqual(new Set(needRecords.map((n) => n.needId)));
  });

  it("an unmapped KPI lands in an explicit bucket rather than vanishing", () => {
    const [orphan] = buildNeedRecords({
      kpiRollups: [kpi("X99", 42)],
      classificationByIndicator: new Map(),
      segmentsByIndicator: new Map(),
      priorCycleByIndicator: new Map(),
      unitGeo: GEO,
      sourceRefBase: SOURCE_REF_BASE,
      thresholds: T,
      surveyId: "srv-1",
      villageScope: "",
    });
    expect(orphan!.domainKey).toBe("UNMAPPED");
    expect(orphan!.domain).toBe("Unmapped Domain");
  });

  it("the executive summary enumerates EVERY methodology domain, assessed or not", () => {
    const needRecords = records();
    const { ranked } = rankPriorityNeeds(needRecords, new Map());
    const allDomains = [
      { domain: "Social Development", domainKey: "SOCIAL_DEVELOPMENT", subDomainCount: 4 },
      { domain: "Governance Services", domainKey: "GOVERNANCE_SERVICES", subDomainCount: 4 },
      { domain: "Health", domainKey: "HEALTH", subDomainCount: 6 },
      { domain: "Education", domainKey: "EDUCATION", subDomainCount: 5 },
    ];
    const es = composeExecutiveSummary({
      allDomains,
      needRecords,
      rankedNeeds: ranked,
      domainSeverityByKey: new Map(),
      domainBandByKey: new Map(),
      subDomainsAssessedByKey: new Map(),
    });

    expect(es.domainDistribution).toHaveLength(allDomains.length);
    expect(es.domainsAssessed).toBe(2);
    expect(es.domainsInMethodology).toBe(4);
    // Health and Education were not assessed — present, and visibly empty.
    expect(es.domainDistribution.filter((d) => !d.assessed).map((d) => d.domain)).toEqual([
      "Health",
      "Education",
    ]);
    expect(es.measuredCount).toBe(2);
    expect(es.notMeasurableCount).toBe(1);
    // Nothing reached CRITICAL, so the heading must not say "critical".
    expect(es.noCriticalBandReached).toBe(true);
  });

  it("suppresses pattern analysis below threshold, stating the threshold", () => {
    const pa = composePatternAnalysis({
      needRecords: records(),
      validResponseCount: 4,
      domainsAssessed: 2,
      domainsNotAssessed: ["Health"],
      thresholds: T,
    });
    expect(pa.status).toBe("insufficient_data");
    expect(pa.suppressionReason).toContain("at least 30 valid responses");
    expect(pa.suppressionReason).toContain("at least 3 assessed domains");
    expect(pa.crossDomainPatterns).toHaveLength(0);
    // Sub-threshold signals are still surfaced, marked as not asserted.
    expect(pa.observedBelowThreshold.every((s) => s.startsWith("Observed, not asserted"))).toBe(true);
    expect(pa.gaps.map((g) => g.domain)).toEqual(["Health"]);
  });

  it("data quality notes are present even when nothing is flagged", () => {
    const dq = composeDataQualityNotes({
      submitted: 0,
      valid: 0,
      excluded: 0,
      dontKnowRate: 0,
      dontKnowRateByDomain: [],
      exclusionBreakdown: [],
      totalAnswers: 0,
      duplicatesFlagged: 0,
      lowConfidenceFlagged: 0,
      needRecords: [],
      domainsNotAssessed: [],
      domainsInMethodology: 9,
      confidenceFlag: "LOW",
      confidenceReason: "Small sample: 0 valid response(s), below the 10 required for STANDARD confidence.",
      thresholds: T,
      trendNote: "Cycle 1 baseline — no prior cycle exists to compare this survey against.",
    });
    expect(dq.present).toBe(true);
    expect(dq.narrative).toBeTruthy();
    // No submissions → 100% (nothing was dropped), not a misleading 0%.
    expect(dq.responseQuality.validResponseRatePct).toBe(100);
  });

  it("data quality notes report the real don't-know band and the not-measured list", () => {
    const needRecords = records();
    const dq = composeDataQualityNotes({
      submitted: 4,
      valid: 4,
      excluded: 0,
      dontKnowRate: 0.0313,
      dontKnowRateByDomain: [{ domain: "Social Development", rate: 0.0313 }],
      exclusionBreakdown: [{ status: "SCORED", count: 32 }],
      totalAnswers: 32,
      duplicatesFlagged: 0,
      lowConfidenceFlagged: 0,
      needRecords,
      domainsNotAssessed: ["Health"],
      domainsInMethodology: 9,
      confidenceFlag: "LOW",
      confidenceReason: "Small sample: 4 valid response(s), below the 10 required for STANDARD confidence.",
      thresholds: T,
      trendNote: "Cycle 1 baseline — no prior cycle exists to compare this survey against.",
    });
    expect(dq.responseQuality.dontKnowBand).toBe("negligible");
    expect(dq.narrative).toContain("which is negligible");
    expect(dq.narrative).not.toMatch(/high rate/i);
    expect(dq.notMeasuredCount).toBe(1);
    expect(dq.notMeasured[0]!.reason).toContain("0 valid responses");
    expect(dq.domainsNotAssessed).toEqual(["Health"]);
  });
});
