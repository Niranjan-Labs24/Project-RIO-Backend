import { describe, expect, it } from "vitest";
import { buildReportDoc } from "./report-doc";
import { findGapMarkers } from "./report-gap-markers";
import { StubReportDataProvider } from "./providers/__fixtures__/report-content.fixtures";
import type { GeneratedReport, GeneratorCtx } from "./generators";
import { individualSurveyGenerator } from "./generators/individual-survey.generator";
import { executiveGenerator } from "./generators/executive.generator";
import { villageGenerator } from "./generators/village.generator";
import { sectorGenerator } from "./generators/sector.generator";
import { regionGenerator } from "./generators/region.generator";
import { topPriorityGenerator } from "./generators/top-priority.generator";
import { dataQualityGenerator } from "./generators/data-quality.generator";

// "A gap marker may never stand in for a value the generator could have
// computed" — the rule from the data attestation, made executable.
//
// RPT10 broke it for weeks: the demographics aggregate was computed and then
// dropped, so the export printed "demographic capture is pending" across real
// captured data (fixed at report-summary-data.provider.ts:268). Nothing threw,
// no test failed, and the only way to notice was to open the PDF and know that
// the study had demographics. This locks the whole class of defect down: each
// report is generated from a fully-populated fixture, rendered, and its printed
// gap markers compared against the exact set that fixture justifies.
//
// The assertion is `toEqual`, not "contains none" — deliberately. A marker
// appearing where it should not is the RPT10 defect; a marker DISAPPEARING
// where it should still appear means a real absence stopped being disclosed,
// which is the same failure pointing the other way.

const AUDIT = [
  { label: "Generated At", value: "08 Sep 2026, 10:30" },
  { label: "Status", value: "released" },
];

const ctx = (over: Partial<GeneratorCtx> = {}): GeneratorCtx => ({
  provider: new StubReportDataProvider(),
  orgId: "org-1",
  studyId: "study-1",
  studyTitle: "Ad-Dilam Baseline",
  filters: {},
  ...over,
});

interface Case {
  code: string;
  run: () => Promise<GeneratedReport>;
  /** Markers this fixture legitimately produces, with the reason. Empty means
   *  the report must print none at all. */
  expected: string[];
  why?: string;
}

const CASES: Case[] = [
  {
    code: "RPT01 Individual Survey",
    run: () => individualSurveyGenerator(ctx({ surveyId: "survey-1" })),
    expected: [],
    why: "survey-scoped fixture is complete — demographics, quality note and trend all resolve",
  },
  {
    code: "RPT14 Village",
    run: () => villageGenerator(ctx({ filters: { villageId: "village-1" } })),
    expected: [],
    why: "village fixture is complete",
  },
  {
    code: "RPT03/RPT09 Top-Priority",
    run: () => topPriorityGenerator(ctx()),
    expected: [],
    why: "ranked list resolves entirely from the fixture",
  },
  {
    code: "RPT10 Data-Quality",
    run: () => dataQualityGenerator(ctx()),
    // The report whose regression prompted this file. `gap.demographics`
    // appearing here again IS that defect returning, so this empty array is
    // the single most load-bearing expectation in the file.
    expected: [],
    why: "demographics ARE present in the fixture and must render, not fall back",
  },
  // The three study-scoped reports below print the demographics banner because
  // the SHARED FIXTURE hardcodes `demographics: null` for them
  // (report-content.fixtures.ts:410, :453, :495) — not because the real
  // provider has no demographics for them. Filling those fixture fields is the
  // follow-up; when it happens these expectations should drop to [] and this
  // test will say so by failing.
  {
    code: "RPT04 Domain-wise Needs",
    run: () => sectorGenerator(ctx()),
    expected: ["gap.demographics"],
    why: "fixture-driven gap: report-content.fixtures.ts:410 sets demographics: null",
  },
  {
    code: "RPT06 Region/Governorate",
    run: () => regionGenerator(ctx()),
    expected: ["gap.demographics"],
    why: "fixture-driven gap: report-content.fixtures.ts:453 sets demographics: null",
  },
  {
    code: "RPT13 Executive Summary",
    run: () => executiveGenerator(ctx()),
    expected: ["gap.demographics"],
    why: "fixture-driven gap: report-content.fixtures.ts:495 sets demographics: null",
  },
];

describe("gap markers over fully-populated fixtures", () => {
  for (const c of CASES) {
    it(`${c.code} prints only the markers its data justifies`, async () => {
      const { title, content } = await c.run();
      const doc = buildReportDoc(title, content, AUDIT);

      expect(findGapMarkers(doc), c.why ?? "").toEqual(c.expected);
    });
  }

  it("RPT10 renders its demographics rather than the pending-capture banner", async () => {
    const { title, content } = await dataQualityGenerator(ctx());

    // The specific RPT10 regression, asserted on the content as well as the
    // rendered doc: the aggregate must survive all the way through, not be
    // computed and discarded.
    expect(content.demographics).not.toBeNull();
    expect(findGapMarkers(buildReportDoc(title, content, AUDIT))).not.toContain("gap.demographics");
  });
});

describe("findGapMarkers", () => {
  it("finds a marker wherever it is printed, not just in section bodies", () => {
    const marker = "Data not available for this study.";

    expect(
      findGapMarkers({
        title: "T",
        headerBand: [{ label: "Methodology Version", value: marker }],
        sections: [],
        audit: AUDIT,
      }),
    ).toEqual(["gap.studyData"]);

    expect(
      findGapMarkers({
        title: "T",
        headerBand: [],
        sections: [{ kind: "note", heading: "Scope", text: marker }],
        audit: AUDIT,
      }),
    ).toEqual(["gap.studyData"]);
  });

  it("looks inside nested column layouts and chapter sections", () => {
    const inner = { kind: "list" as const, heading: "Findings", items: ["Data not available"] };

    expect(
      findGapMarkers({
        title: "T",
        headerBand: [],
        sections: [{ kind: "columns", children: [inner] }],
        audit: [],
      }),
    ).toEqual(["gap.date"]);

    expect(
      findGapMarkers({
        title: "T",
        headerBand: [],
        sections: [],
        audit: [],
        chapters: [{ name: "Evidence", summary: "Documents", sections: [inner] }],
      }),
    ).toEqual(["gap.date"]);
  });

  it("reports nothing for a document that states no absences", () => {
    expect(
      findGapMarkers({
        title: "Ad-Dilam Baseline",
        headerBand: [{ label: "Study", value: "Ad-Dilam Baseline" }],
        sections: [{ kind: "stats", heading: "Coverage", tiles: [{ label: "Needs", value: "24" }] }],
        audit: AUDIT,
      }),
    ).toEqual([]);
  });
});
