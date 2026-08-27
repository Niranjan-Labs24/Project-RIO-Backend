import { describe, expect, it } from "vitest";
import { buildReportDoc } from "./report-doc";
import { renderReportPdf } from "./pdf-builder";

// RIO-FR-024: population/requiredSampleSize/minimumDetectableEffect must
// appear in the exported Response Quality block, since they're computed
// per-study and directly explain why the confidence flag is what it is.
const CONTENT_WITH_SAMPLE_SIZE: Record<string, unknown> = {
  header: {
    studyName: "water",
    entityName: "Demo NGO",
    methodologyVersion: "v1.0 - Approved implementation baseline",
    cycleNumber: 1,
    dateTime: "2026-08-06T10:00:00.000Z",
  },
  // Minimal trigger for buildReportDoc's `isCore` structured-document branch
  // (otherwise it falls back to a flat key/value dump) — irrelevant to what
  // this test actually checks (Response Quality's sample-size rows).
  severity: {},
  responseQuality: {
    submittedResponses: 90,
    validResponses: 90,
    overallConfidence: "LOW",
    confidenceReason: "Below coverage target: 90 valid response(s), below the 94 required for this study's population at the configured confidence level and margin of error.",
    validResponseRatePct: 100,
    dontKnowRate: 0,
    dontKnowBand: "negligible",
    population: 5000,
    requiredSampleSize: 94,
    minimumDetectableEffect: 14.4,
  },
  filters: {},
  reportKind: "report",
};

const CONTENT_WITHOUT_SAMPLE_SIZE: Record<string, unknown> = {
  header: {
    studyName: "water",
    entityName: "Demo NGO",
    methodologyVersion: "v1.0 - Approved implementation baseline",
    cycleNumber: 1,
    dateTime: "2026-08-06T10:00:00.000Z",
  },
  // Minimal trigger for buildReportDoc's `isCore` structured-document branch
  // (otherwise it falls back to a flat key/value dump) — irrelevant to what
  // this test actually checks (Response Quality's sample-size rows).
  severity: {},
  responseQuality: {
    submittedResponses: 42,
    validResponses: 38,
    overallConfidence: "STANDARD",
    confidenceReason: "High response completeness.",
    validResponseRatePct: 90,
    dontKnowRate: 0,
    dontKnowBand: "negligible",
  },
  filters: {},
  reportKind: "report",
};

describe("Response Quality — RIO-FR-024 sample-size rows", () => {
  it("renders population, required sample size and MDE when the study has them", () => {
    const doc = buildReportDoc("water", CONTENT_WITH_SAMPLE_SIZE, []);
    const blob = JSON.stringify(doc);
    expect(blob).toContain("Population (area)");
    expect(blob).toContain("5000");
    expect(blob).toContain("Required sample size");
    expect(blob).toContain("94");
    expect(blob).toContain("Minimum detectable effect");
    expect(blob).toContain("±14.4 pts");
  });

  it("prints the plus-minus sign as ASCII, not as question marks, in the PDF", () => {
    // Base Helvetica has no plus-minus glyph, and the renderer's UTF-8 ->
    // Latin-1 step turned its two bytes into two question marks: the MDE row
    // read "??14.4 pts", which looks like a rendering fault sitting on top of
    // a statistical figure. The document keeps the real sign (the web viewer
    // can draw it); only the PDF folds it.
    const doc = buildReportDoc("water", CONTENT_WITH_SAMPLE_SIZE, []);
    const pdf = renderReportPdf(doc).toString("latin1");
    expect(pdf).toContain("+/-14.4 pts");
    expect(pdf).not.toContain("??");
  });

  it("omits the three rows entirely for a study with no sample-size data (pre-existing studies)", () => {
    const doc = buildReportDoc("water", CONTENT_WITHOUT_SAMPLE_SIZE, []);
    const blob = JSON.stringify(doc);
    expect(blob).not.toContain("Population (area)");
    expect(blob).not.toContain("Required sample size");
    expect(blob).not.toContain("Minimum detectable effect");
  });
});
