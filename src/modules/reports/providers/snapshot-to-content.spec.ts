import { describe, expect, it } from "vitest";
import type { ReportDataSnapshot } from "../report-summary.service";
import { DATA_QUALITY_NOTE_UNAVAILABLE, SINGLE_CYCLE_TREND_NOTE } from "../report-content.types";
import {
  EMPTY_APPROVAL,
  aiOutputToSummaryBlock,
  snapshotToExecutiveContent,
  snapshotToRegionContent,
  snapshotToSectorContent,
  snapshotToVillageContent,
} from "./snapshot-to-content";

function snapshot(): ReportDataSnapshot {
  return {
    snapshotId: "snap-1",
    generatedAt: "2026-07-22T10:30:00Z",
    scope: "VILLAGE",
    scopeFilters: { villageId: "VIL-001" },
    study: {
      studyId: "study-1",
      studyName: "Water Assessment",
      surveyId: "srv-1",
      villageId: "VIL-001",
      villageName: "Ad-Dilam",
      assessmentCycle: 1,
      organizationName: "Demo NGO",
      methodologyVersionId: "mv-uuid",
      governorateName: "Riyadh",
      regionName: "Riyadh Region",
    },
    responseQuality: {
      submittedResponseCount: 42,
      validResponseCount: 38,
      dontKnowRate: 12.4,
      confidenceLevel: "STANDARD",
      confidenceReason: "",
    },
    severity: {
      overallVillageNeedsIndex: 63.8,
      severityBand: "Medium",
      domainSeverityScores: [
        { domainKey: "HEALTH", domainName: "Health", severityScore: 72, confidenceLevel: "STANDARD", validResponseCount: 35, excludedResponseCount: 3, dontKnowRate: 0.05, kpiCount: 6 },
        { domainKey: "WATER_SANITATION", domainName: "Water & Sanitation", severityScore: 81, confidenceLevel: "LOW", validResponseCount: 8, excludedResponseCount: 12, dontKnowRate: 0.25, kpiCount: 5 },
      ],
      topKpis: [
        { rank: 1, kpiName: "Daily Clean Water Access", indicatorName: "IND-1", domainName: "Water & Sanitation", severityScore: 88, confidenceLevel: "LOW", validResponseCount: 8 },
        { rank: 2, kpiName: "Availability of Essential Medicines", indicatorName: "IND-2", domainName: "Health", severityScore: 78, confidenceLevel: "STANDARD", validResponseCount: 35 },
      ],
    },
    priority: {
      villagePriorityScore: 37.45,
      priorityStatus: "HIGH",
      domainPerformanceScores: [
        { domainKey: "HEALTH", domainName: "Health", severityScore: 72, performanceScore: 28, weight: 0.3, weightedContribution: 8.4, isCriticalDomain: true, triggeredOverride: false },
        { domainKey: "WATER_SANITATION", domainName: "Water & Sanitation", severityScore: 81, performanceScore: 19, weight: 0.1, weightedContribution: 1.9, isCriticalDomain: true, triggeredOverride: true },
      ],
      overrideApplied: true,
      overrideReason: "Critical Domain Override: Water & Sanitation performance score is 19, below the threshold of 30.",
      calculatedAt: "2026-07-22T09:00:00Z",
    },
    evidence: [
      { id: "ev-1", evidenceTitle: "Water shortage", type: "note", sourceReferenceId: "REF-1", linkedDomainOrKpi: "Water & Sanitation", description: "Irregular water supply reported.", collectedDate: "2026-07-10" },
    ],
  };
}

const aiOutput = {
  executiveSummary: "Ad-Dilam has a High Priority status.",
  keyFindings: [
    { title: "Water severity", domain: "Water & Sanitation", kpi: "Access", confidence: "LOW", summary: "Water & Sanitation has the highest severity." },
    { title: "Health", domain: "Health", kpi: "Medicine", confidence: "STANDARD", summary: "Health also requires attention." },
  ],
  dataQualityNote: "Water & Sanitation has Low Confidence.",
  trendNote: "Cycle 1 assessment: Trend Pending.",
  draftNextSteps: ["Validate water-access findings.", "Assess safe-water availability."],
};

describe("snapshot-to-content mappers", () => {
  it("maps a real snapshot + AI output to the village content shape", () => {
    const c = snapshotToVillageContent({ snapshot: snapshot(), aiOutput, assessmentPeriod: "01 July 2026 - 15 July 2026" });

    expect(c.header.studyName).toBe("Water Assessment");
    expect(c.header.entityName).toBe("Demo NGO");
    expect(c.village.name).toBe("Ad-Dilam");
    expect(c.village.assessmentCycle).toBe(1);
    expect(c.village.assessmentPeriod).toBe("01 July 2026 - 15 July 2026");

    expect(c.responseQuality.submittedResponses).toBe(42);
    expect(c.responseQuality.validResponses).toBe(38);
    expect(c.responseQuality.overallConfidence).toBe("STANDARD");

    expect(c.severity.overallVillageNeedsIndex).toBe(63.8);
    expect(c.severity.label).toBe("Medium");

    const water = c.severity.domains.find((d) => d.name === "Water & Sanitation")!;
    expect(water.severityScore).toBe(81);
    expect(water.performanceScore).toBe(19);
    expect(water.weight).toBe(0.1);
    expect(water.confidence).toBe("LOW");
    expect(water.isCriticalDomain).toBe(true);
    expect(water.validResponseCount).toBe(8); // low-confidence domains surface sample size
    // New domain columns: methodology code, KPI count, quantitative confidence
    // % (valid-response ratio = 8 / (8 + 12) = 40%), and per-domain trend note.
    expect(water.domainCode).toBe("WATER_SANITATION");
    expect(water.kpiCount).toBe(5);
    expect(water.confidencePct).toBe(40);
    expect(water.trendNote).toBe(SINGLE_CYCLE_TREND_NOTE);

    expect(c.priority.villagePriorityScore).toBe(37.45);
    expect(c.priority.priorityStatus).toBe("HIGH");
    expect(c.priority.overrideApplied).toBe(true);

    expect(c.topKpis[0]?.kpi).toBe("Daily Clean Water Access");
    expect(c.topKpis[0]?.confidence).toBe("LOW");

    expect(c.qualitativeEvidence[0]).toEqual({ theme: "Water shortage", summary: "Irregular water supply reported." });

    expect(c.aiSummary.executiveSummary).toBe("Ad-Dilam has a High Priority status.");
    expect(c.aiSummary.keyFindings).toContain("highest severity");
    expect(c.aiSummary.recommendations).toEqual(["Validate water-access findings.", "Assess safe-water availability."]);
    // Data Quality + Trend notes promoted to first-class fields, blanked in aiSummary.
    expect(c.dataQualityNote).toBe("Water & Sanitation has Low Confidence.");
    expect(c.trendNote).toBe("Cycle 1 assessment: Trend Pending.");
    expect(c.aiSummary.dataQualityNote).toBe("");
    expect(c.aiSummary.trendNote).toBe("");

    expect(c.demographics).toBeNull();
    expect(c.approval).toEqual(EMPTY_APPROVAL);
  });

  it("passes real gender/rural demographics through when provided", () => {
    const c = snapshotToVillageContent({
      snapshot: snapshot(),
      demographics: { gender: [{ label: "Female", count: 21 }], rural: [{ label: "Rural", count: 26 }] },
    });
    expect(c.demographics?.gender[0]).toEqual({ label: "Female", count: 21 });
    // …and stays null when not captured.
    expect(snapshotToVillageContent({ snapshot: snapshot() }).demographics).toBeNull();
  });

  it("aiOutputToSummaryBlock tolerates a missing AI output", () => {
    const block = aiOutputToSummaryBlock(null);
    expect(block.executiveSummary).toBe("");
    expect(block.recommendations).toEqual([]);
  });

  it("maps sector / region / executive scopes", () => {
    const sector = snapshotToSectorContent({ snapshot: snapshot() });
    expect(sector.domains.some((d) => d.name === "Health")).toBe(true);
    // No AI output → notes fall back to placeholders (never blank), and are
    // still present as first-class fields.
    expect(sector.dataQualityNote).toBe(DATA_QUALITY_NOTE_UNAVAILABLE);
    expect(sector.trendNote).toBe(SINGLE_CYCLE_TREND_NOTE);
    expect(sector.aiSummary.dataQualityNote).toBe("");

    const region = snapshotToRegionContent({ snapshot: snapshot(), aiOutput });
    expect(region.regions[0]?.priorityStatus).toBe("HIGH");
    expect(region.regions[0]?.priorityScore).toBe(37.45);
    // New/populated region columns: actual region name, governorate name,
    // contributing responses, and severity score shown alongside priority score.
    expect(region.regions[0]?.regionName).toBe("Riyadh Region");
    expect(region.regions[0]?.governorate).toBe("Riyadh");
    expect(region.regions[0]?.responseCount).toBe(38);
    expect(region.regions[0]?.severityScore).toBe(63.8);
    // Data Quality and Trend notes are promoted to first-class fields and
    // removed from the AI Summary block (no duplication).
    expect(region.dataQualityNote).toBe("Water & Sanitation has Low Confidence.");
    expect(region.trendNote).toBe("Cycle 1 assessment: Trend Pending.");
    expect(region.aiSummary.dataQualityNote).toBe("");
    expect(region.aiSummary.trendNote).toBe("");

    const exec = snapshotToExecutiveContent({ snapshot: snapshot(), aiOutput });
    expect(exec.topPriorities.length).toBeGreaterThan(0);
    // Water & Sanitation is Low-confidence + critical → flagged as an anomaly.
    expect(exec.anomalies.some((a) => a.includes("Water & Sanitation"))).toBe(true);
    // Structured scope (Region / Governorate) and quantitative confidence %.
    expect(exec.scope.villages).toBe("Ad-Dilam");
    expect(exec.scope.governorate).toBe("Riyadh");
    // 38 valid / 42 submitted = 90%.
    expect(exec.responseQuality.confidencePct).toBe(90);
  });
});
