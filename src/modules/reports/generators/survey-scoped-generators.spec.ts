import { describe, expect, it } from "vitest";
import type { CoverageBlock } from "../report-content.types";
import { StubReportDataProvider } from "../providers/__fixtures__/report-content.fixtures";
import { buildReportDoc } from "../report-doc";
import { renderReportExcel } from "../excel-builder";
import { renderReportPdf } from "../pdf-builder";
import { combinedGenerator } from "./combined.generator";
import { individualSurveyGenerator } from "./individual-survey.generator";
import type { GeneratorCtx } from "./index";

function ctx(over: Partial<GeneratorCtx> = {}): GeneratorCtx {
  return {
    provider: new StubReportDataProvider(),
    orgId: "org-1",
    studyId: "study-1",
    surveyId: "survey-1",
    studyTitle: "Village Community Needs Assessment",
    filters: {},
    ...over,
  };
}

describe("RPT01 individualSurveyGenerator", () => {
  it("titles by survey, not by study, so sibling surveys stay distinguishable", async () => {
    const a = await individualSurveyGenerator(ctx({ surveyId: "survey-1" }));
    expect(a.title).toBe("Individual Survey Report — Baseline Household Survey");
    expect(a.title).not.toContain("Village Community Needs Assessment");
  });

  it("requires both a studyId and a surveyId", async () => {
    await expect(individualSurveyGenerator(ctx({ studyId: undefined }))).rejects.toThrow();
    await expect(individualSurveyGenerator(ctx({ surveyId: undefined }))).rejects.toThrow();
  });

  it("carries the survey identity, coverage counts, funnel and question coverage", async () => {
    const { content } = await individualSurveyGenerator(ctx());

    const survey = content.survey as Record<string, unknown>;
    expect(survey.surveyId).toBe("survey-1");
    expect(survey.needStatement).toBeTruthy();

    const coverage = content.coverage as CoverageBlock;
    expect(coverage.needsInStudy).toBe(3);
    expect(coverage.surveyQuestionsTotal).toBe(28);
    expect(coverage.responsesSubmitted).toBe(42);
    expect(coverage.domainsScored).toBe(5);

    expect(Array.isArray(content.responseFunnel)).toBe(true);
    expect(Array.isArray(content.questionCoverage)).toBe(true);
  });

  it("coverage counts reconcile internally (valid + excluded = submitted)", async () => {
    const { content } = await individualSurveyGenerator(ctx());
    const c = content.coverage as CoverageBlock;
    expect(c.responsesValid + c.responsesExcluded).toBe(c.responsesSubmitted);
    expect(c.surveyQuestionsFromBank + c.surveyQuestionsCustom).toBe(c.surveyQuestionsTotal);
    expect(c.evidenceIncludedInReport).toBeLessThanOrEqual(c.evidenceFilesTotal);
  });

  it("renders as a core doc — charts, not a flat key/value dump", () => {
    return individualSurveyGenerator(ctx()).then(({ title, content }) => {
      const doc = buildReportDoc(title, content, []);
      const kinds = doc.sections.flatMap((s) => (s.kind === "columns" ? s.children.map((c) => c.kind) : [s.kind]));

      // The isCore path produces these; the generic flatten fallback cannot.
      expect(kinds).toContain("stats"); // coverage tiles
      expect(kinds).toContain("gauge"); // needs index
      expect(kinds).toContain("radar"); // domain profile
      expect(kinds).toContain("bars"); // severity + funnel
      expect(kinds).toContain("pie"); // demographics
    });
  });
});

describe("RPT15 combinedGenerator", () => {
  it("titles by survey and carries both halves", async () => {
    const { title, content } = await combinedGenerator(ctx());
    expect(title).toBe("Survey & Dashboard Report — Baseline Household Survey");

    expect(content.severity).toBeTruthy(); // survey half
    expect(content.dashboard).toBeTruthy(); // dashboard half
    expect(content.portfolio).toBeTruthy(); // org counts
    expect(Array.isArray(content.comparison)).toBe(true);
  });

  it("requires both a studyId and a surveyId", async () => {
    await expect(combinedGenerator(ctx({ studyId: undefined }))).rejects.toThrow();
    await expect(combinedGenerator(ctx({ surveyId: undefined }))).rejects.toThrow();
  });

  it("stamps the dashboard capture separately from the survey snapshot", async () => {
    const { content } = await combinedGenerator(ctx());
    const dashboard = content.dashboard as Record<string, unknown>;
    expect(typeof dashboard.capturedAt).toBe("string");
  });

  it("renders the dashboard half's charts as well as the survey half's", async () => {
    const { title, content } = await combinedGenerator(ctx());
    const doc = buildReportDoc(title, content, []);
    const kinds = doc.sections.flatMap((s) => (s.kind === "columns" ? s.children.map((c) => c.kind) : [s.kind]));

    expect(kinds).toContain("stats"); // coverage + portfolio tiles
    expect(kinds).toContain("gauge"); // needs index + SLA
    expect(kinds).toContain("groupedBars"); // survey vs organisation
    expect(kinds).toContain("bars"); // scoring distribution

    const headings = doc.sections
      .flatMap((s) => (s.kind === "columns" ? s.children : [s]))
      .map((s) => ("heading" in s ? s.heading : ""));
    expect(headings).toContain("Assessment Coverage");
    expect(headings).toContain("Organisation Portfolio");
    expect(headings).toContain("This Survey vs. Organisation");
  });
});

// The property that stops the combined report becoming "two reports stapled
// together with numbers that disagree". Both must be built from one snapshot.
describe("RPT01 / RPT15 reconciliation", () => {
  it("the combined report's survey half is identical to the individual report", async () => {
    const individual = await individualSurveyGenerator(ctx());
    const combined = await combinedGenerator(ctx());

    for (const field of ["severity", "priority", "topKpis", "responseQuality", "coverage", "demographics", "survey"]) {
      expect(combined.content[field], `${field} drifted between RPT01 and RPT15`).toEqual(
        individual.content[field],
      );
    }
  });

  it("the comparison band never invents a direction its own numbers contradict", async () => {
    const { content } = await combinedGenerator(ctx());
    const rows = content.comparison as Array<{
      surveyValue: number;
      orgAverage: number;
      delta: number;
      direction: string;
    }>;

    for (const r of rows) {
      expect(r.delta).toBe(r.surveyValue - r.orgAverage);
      if (r.direction === "above") expect(r.delta).toBeGreaterThan(0);
      if (r.direction === "below") expect(r.delta).toBeLessThan(0);
      if (r.direction === "inline") expect(Math.abs(r.delta)).toBeLessThanOrEqual(3);
    }
  });
});

describe("survey-scoped exports", () => {
  it("RPT01 exports to a non-empty PDF and Excel", async () => {
    const { title, content } = await individualSurveyGenerator(ctx());
    const doc = buildReportDoc(title, content, [{ label: "Status", value: "released" }]);

    const pdf = renderReportPdf(doc);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2000);

    const xlsx = await renderReportExcel(doc);
    expect(xlsx.length).toBeGreaterThan(2000);
  });

  it("RPT15 exports to a non-empty PDF and Excel", async () => {
    const { title, content } = await combinedGenerator(ctx());
    const doc = buildReportDoc(title, content, [{ label: "Status", value: "released" }]);

    const pdf = renderReportPdf(doc);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2000);

    const xlsx = await renderReportExcel(doc);
    expect(xlsx.length).toBeGreaterThan(2000);
  });
});
