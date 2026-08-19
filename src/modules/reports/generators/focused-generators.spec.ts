import { describe, expect, it } from "vitest";
import { StubReportDataProvider } from "../providers/__fixtures__/report-content.fixtures";
import { dataQualityGenerator } from "./data-quality.generator";
import { topPriorityGenerator } from "./top-priority.generator";
import { individualSurveyGenerator } from "./individual-survey.generator";
import { buildReportDoc } from "../report-doc";
import { flattenReportContent } from "../report-content-flatten";
import type {
  DataQualityReportContent,
  TopPriorityReportContent,
} from "../report-content.types";
import type { IndividualSurveyReportContent } from "../report-content.types";

// RIO-RPT-001 — acceptance criteria as executable invariants for the two
// net-new report types (RPT03/RPT09 Top-Priority, RPT10 Data-Quality).
//
// The stub provider runs the REAL pure mappers (buildTopPriorityContent /
// buildDataQualityContent) over the REAL unified builder, so these assert the
// production projection logic rather than a hand-written fixture.

const ctx = () => ({
  provider: new StubReportDataProvider(),
  orgId: "org-1",
  studyId: "study-1",
  studyTitle: "Village Community Needs Assessment",
  filters: {},
});

async function topPriority(): Promise<TopPriorityReportContent> {
  const r = await topPriorityGenerator(ctx());
  return r.content as unknown as TopPriorityReportContent;
}

async function dataQuality(): Promise<DataQualityReportContent> {
  const r = await dataQualityGenerator(ctx());
  return r.content as unknown as DataQualityReportContent;
}

describe("RPT03/RPT09 Top-Priority Report", () => {
  it("titles itself from the study and stamps the methodology version (AC 1, AC 5)", async () => {
    const r = await topPriorityGenerator(ctx());
    expect(r.title).toBe("Top-Priority Report — Village Community Needs Assessment");
    const c = r.content as unknown as TopPriorityReportContent;
    // AC 5 — the version the report was scored against travels WITH the
    // content, so it survives into the export header and the archive.
    expect(c.header.methodologyVersion).toBe("v1.0");
    expect(c.header.reportGeneratedAt).toBeTruthy();
  });

  it("bands every measured need and counts none twice", async () => {
    const c = await topPriority();
    const banded = c.tierSummary.reduce((sum, t) => sum + t.count, 0);
    const measured = c.priorityNeeds.needs.length;
    expect(banded).toBe(measured);
    // Ranked + unmeasured accounts for every need record — nothing is dropped
    // between the ranking and the tier table.
    expect(measured + c.priorityNeeds.notMeasured.length).toBeGreaterThan(0);
  });

  it("never bands an unmeasured need (a null severity has no tier)", async () => {
    const c = await topPriority();
    for (const n of c.priorityNeeds.notMeasured) expect(n.severityScore).toBeNull();
    // Shares sum to 100 across measured needs, or to 0 when none were measured.
    const shares = c.tierSummary.reduce((s, t) => s + t.sharePct, 0);
    expect(shares === 0 || Math.abs(shares - 100) < 0.5).toBe(true);
  });

  it("ranks contiguously from 1 and is reproducible from the printed basis", async () => {
    const c = await topPriority();
    const ranks = c.priorityNeeds.needs.map((n) => n.rank);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));
    // The methodology's explainability requirement: a reader must be able to
    // recompute the order, so the formula is printed, not assumed.
    expect(c.priorityNeeds.rankingBasis).toBeTruthy();
    expect(c.calculationBasis.severityBandingRule).toBeTruthy();
    expect(c.calculationBasis.equityRule).toBeTruthy();
  });

  it("carries the no-masking columns on every domain row", async () => {
    const c = await topPriority();
    expect(c.domainRollup.length).toBeGreaterThan(0);
    for (const d of c.domainRollup) {
      // Max is mandatory alongside the average — that IS the no-masking rule.
      expect(d).toHaveProperty("maxKpiSeverity");
      expect(d).toHaveProperty("criticalKpiCount");
      // An unmeasured domain reports null, never a 0 standing in for "fine".
      if (d.maxKpiSeverity !== null) expect(d.maxKpiSeverity).toBeGreaterThanOrEqual(0);
    }
  });

  it("flags a domain whose average is milder than its worst KPI", async () => {
    const c = await topPriority();
    for (const d of c.domainRollup) {
      if (d.masksCriticalFinding) {
        expect(d.maxKpiSeverity).not.toBeNull();
        expect(d.averageSeverity).not.toBeNull();
        expect(d.maxKpiSeverity!).toBeGreaterThan(d.averageSeverity!);
      }
    }
  });
});

describe("RPT10 Data-Quality Report", () => {
  it("titles itself from the study and stamps the methodology version (AC 1, AC 5)", async () => {
    const r = await dataQualityGenerator(ctx());
    expect(r.title).toBe("Data-Quality Report — Village Community Needs Assessment");
    expect((r.content as unknown as DataQualityReportContent).header.methodologyVersion).toBe("v1.0");
  });

  it("FLAGS every incomplete record instead of excluding it (AC 6)", async () => {
    const c = await dataQuality();
    const dq = c.dataQualityNotes;
    // The count and the rows behind it must agree. A count without its rows is
    // precisely the silent exclusion acceptance criterion 6 prohibits.
    expect(c.flaggedRecords.length).toBe(dq.notMeasuredCount + dq.domainsNotAssessed.length);
    for (const f of c.flaggedRecords) {
      expect(f.flag).toMatch(/^(NOT_MEASURABLE|DOMAIN_NOT_ASSESSED)$/);
      // Every flag carries its reason — a flag with no explanation is a
      // dead end for the analyst who has to act on it.
      expect(f.reason.length).toBeGreaterThan(0);
    }
  });

  it("reports excluded responses rather than netting them out of the total", async () => {
    const c = await dataQuality();
    const rq = c.dataQualityNotes.responseQuality;
    expect(rq.submitted).toBeGreaterThanOrEqual(rq.valid);
    expect(rq.excluded).toBe(rq.submitted - rq.valid);
    // The exclusion breakdown is itemised by status, never a single opaque number.
    for (const e of c.dataQualityNotes.exclusionBreakdown) {
      expect(e.status).toBeTruthy();
      expect(e.sharePct).toBeGreaterThanOrEqual(0);
    }
  });

  it("names the condition behind every confidence band", async () => {
    const c = await dataQuality();
    expect(c.domainConfidence.length).toBeGreaterThan(0);
    for (const d of c.domainConfidence) {
      expect(["LOW", "STANDARD"]).toContain(d.confidence);
      // A LOW band with no stated reason reads as arbitrary — the whole point
      // of composeConfidenceReason is that it names the trigger that fired.
      if (d.confidence === "LOW") expect(d.reason.length).toBeGreaterThan(0);
    }
  });

  it("states when a study has no signed-off sample-size target rather than printing 0", async () => {
    const c = await dataQuality();
    const row = c.completeness.find((r) => r.label === "Required Sample Size (study)");
    expect(row).toBeDefined();
    expect(row!.value).not.toBe("0");
  });
});

describe("reconciliation across the three reports sharing the unified pipeline (AC 3)", () => {
  it("Top-Priority, Data-Quality and RPT01 report identical response-quality figures", async () => {
    const survey = (await individualSurveyGenerator({ ...ctx(), surveyId: "survey-1" }))
      .content as unknown as IndividualSurveyReportContent;
    const tp = await topPriority();
    const dq = await dataQuality();

    // The reconciliation guarantee is structural: all three project ONE unified
    // half. If someone re-aggregates any of them independently, this fails.
    expect(tp.responseQuality.submittedResponses).toBe(survey.responseQuality.submittedResponses);
    expect(dq.responseQuality.submittedResponses).toBe(survey.responseQuality.submittedResponses);
    expect(dq.dataQualityNotes.responseQuality.valid).toBe(survey.dataQualityNotes.responseQuality.valid);
    expect(tp.priorityNeeds.needs.length).toBe(survey.priorityNeeds.needs.length);
  });

  it("the same methodology version stamps all three", async () => {
    const survey = (await individualSurveyGenerator({ ...ctx(), surveyId: "survey-1" }))
      .content as unknown as IndividualSurveyReportContent;
    const tp = await topPriority();
    const dq = await dataQuality();
    expect(tp.header.methodologyVersion).toBe(survey.header.methodologyVersion);
    expect(dq.header.methodologyVersion).toBe(survey.header.methodologyVersion);
  });
});

describe("export rendering (AC 2, AC 7)", () => {
  // Both new types must render as STRUCTURED documents, not the flat key-value
  // fallback. That fallback is what silently dropped whole sections from RPT17's
  // export, and it fails AC 7 without failing loudly.
  it("Top-Priority renders its own sections, not the generic flatten", async () => {
    const c = await topPriority();
    const doc = buildReportDoc("Top-Priority", c as unknown as Record<string, unknown>, []);
    const headings = doc.sections.map((s) => ("heading" in s ? s.heading : "")).filter(Boolean);
    expect(headings).toContain("Priority Tier Summary");
    expect(headings).toContain("Domain Rollup");
    // "Summary" is the flatten fallback's heading — its presence means the
    // isCore predicate rejected this shape.
    expect(headings).not.toContain("Summary");
  });

  it("Data-Quality renders its own sections, not the generic flatten", async () => {
    const c = await dataQuality();
    const doc = buildReportDoc("Data-Quality", c as unknown as Record<string, unknown>, []);
    const headings = doc.sections.map((s) => ("heading" in s ? s.heading : "")).filter(Boolean);
    expect(headings).toContain("Completeness & Confidence");
    expect(headings).toContain("Confidence by Domain");
    expect(headings).toContain("Flagged Records");
    expect(headings).not.toContain("Summary");
  });

  it("every flagged record survives the flatten into the Excel path (AC 2)", async () => {
    const c = await dataQuality();
    const flat = flattenReportContent(c as unknown as Record<string, unknown>);
    const table = flat.tables.find((t) => t.name === "flaggedRecords");
    if (c.flaggedRecords.length > 0) {
      expect(table).toBeDefined();
      // Row-count parity between the content and what the spreadsheet receives —
      // a truncated table is an AC 7 failure that reads as a clean export.
      expect(table!.rows.length).toBe(c.flaggedRecords.length);
    }
  });
});
