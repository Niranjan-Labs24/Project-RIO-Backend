import { describe, expect, it } from "vitest";
import { renderReportPdf } from "./pdf-builder";
import { renderReportExcel } from "./excel-builder";
import type { DocSection, ReportDoc } from "./report-doc";

// One document holding every section kind the renderers draw, so each is
// exercised in both export formats, both directions and both PDF modes.
const many = (n: number, f: (i: number) => string[]) => Array.from({ length: n }, (_, i) => f(i));

const sections: DocSection[] = [
  {
    kind: "summaryPanel",
    title: "At a glance",
    columns: [
      { label: "What we found", text: "Health is the most severe need.", lead: "Health", caveat: "Low confidence" },
      { label: "How confident", text: "12 valid responses of 81 required." },
      { label: "Decision", text: "Collect more data before acting." },
    ],
  },
  {
    kind: "bandScale",
    heading: "Confidence",
    segments: [
      { band: "VERY_LOW", label: "Very low", grow: 1, active: false },
      { band: "MEDIUM", label: "Medium", grow: 2, active: true },
      { band: "STRONG", label: "Strong", grow: 3, active: false },
    ],
    note: "12 valid responses; 81 needed for strong confidence.",
  },
  {
    kind: "card",
    heading: "Excluded responses",
    hint: "Left out of every figure",
    children: [
      { kind: "caption", text: "EXCLUDED RESPONSES" },
      { kind: "stats", heading: "", tiles: [{ label: "Duplicates", value: "1" }, { label: "Low confidence", value: "1", sub: "of 15" }] },
    ],
  },
  { kind: "card", heading: "A card that flows", flow: true, children: [{ kind: "panel", text: "Shaded prose. ".repeat(60) }] },
  {
    kind: "callouts",
    items: [
      { label: "Strong", text: "Act on these findings.", tone: "ok" },
      { label: "Medium", text: "Confirm, then act.", tone: "medium" },
      { label: "Very low", text: "Collect more data.", tone: "danger" },
    ],
  },
  { kind: "footnote", text: "Reviewed by the Human Reviewer on 23 Oct 2026." },
  {
    kind: "rings",
    heading: "Who answered",
    items: [
      { label: "Gender", slices: [{ label: "Female", value: 7 }, { label: "Male", value: 5 }] },
      { label: "Age", slices: [{ label: "18-24", value: 4 }, { label: "25-44", value: 8 }] },
    ],
  },
  { kind: "anchor", id: "top" },
  { kind: "navGrid", heading: "Domains", tiles: [{ label: "Health", sub: "81 · Critical", to: "health" }, { label: "Education", sub: "40", to: "health" }] },
  {
    kind: "table",
    heading: "Severity by Domain",
    subheading: "Highest first",
    columns: ["Domain", "Severity", "Band", "Confidence"],
    rows: many(45, (i) => [`Domain ${i} with a fairly long name that wraps`, String(90 - i), i % 2 ? "HIGH" : "LOW", i % 3 ? "STANDARD" : "LOW"]),
    rowLinks: many(45, (i) => [i === 0 ? "health" : ""]).map(([x]) => x || null),
    tones: many(45, (i) => [i % 4 === 0 ? "danger" : i % 4 === 1 ? "ok" : i % 4 === 2 ? "strong" : "medium"]).map((t) => [null, t[0] as never, null, null]),
  },
  { kind: "table", heading: "Roomy table", roomy: true, columns: ["KPI", "Score"], rows: [["Distance to the nearest clinic", "88"]], tones: [[null, "danger"]] },
  { kind: "table", heading: "Empty table", columns: ["A"], rows: [] },
  { kind: "keyvalue", heading: "Response Quality", rows: [{ label: "Valid responses", value: "12" }, { label: "Why this band", value: "Fewer than required. ".repeat(10) }] },
  { kind: "bars", heading: "Responses per village", max: 10, bars: [{ label: "Al Aham", value: 9 }, { label: "Al Qarain", value: 3 }, { label: "Zero", value: 0 }] },
  { kind: "pie", heading: "Gender", slices: [{ label: "Female", value: 7 }, { label: "Male", value: 5 }] },
  { kind: "pie", heading: "One slice", emphasis: true, slices: [{ label: "All", value: 3 }] },
  { kind: "gauge", heading: "Needs Index", value: 72, max: 100, sub: "High" },
  { kind: "radar", heading: "Domain profile", max: 100, axes: ["Health", "Education", "Water", "Livelihood"], series: [{ name: "This survey", values: [81, 40, 20, 55] }, { name: "Organisation", values: [60, 50, 30, 45] }] },
  { kind: "list", heading: "Anomalies", items: ["[WARNING] 3 responses flagged low confidence", "A second item"] },
  { kind: "note", heading: "Data quality", text: "Figures are a frozen snapshot taken at generation time." },
  { kind: "groupedBars", heading: "This survey vs organisation", max: 100, groups: ["Needs Index", "Priority"], series: [{ name: "Survey", values: [43, 57] }, { name: "Organisation", values: [50, 56] }] },
  {
    kind: "columns",
    weights: [1, 2],
    children: [
      { kind: "gauge", heading: "Compliance", value: 100, max: 100, sub: "%" },
      { kind: "keyvalue", heading: "Dashboard KPIs", rows: [{ label: "Number of needs", value: "9" }] },
    ],
  },
  { kind: "pageBreak", anchorId: "health", heading: "Health — Domain Detail" },
  { kind: "breadcrumb", trail: [{ label: "Contents", to: "top" }, { label: "Health" }] },
  { kind: "note", heading: "Health", text: "Detail page." },
];

const doc = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  title: "Survey & Dashboard Report — Sample Study",
  headerBand: [
    { label: "Organisation", value: "Sample Charity" },
    { label: "Generated", value: "23 Oct 2026, 10:00" },
  ],
  sections,
  audit: [{ label: "Reviewed by", value: "Reviewer" }],
  badge: "DRAFT",
  ...over,
});

const isPdf = (b: Buffer) => b.subarray(0, 5).toString() === "%PDF-";

describe("every section kind renders", () => {
  it.each(["en", "ar"] as const)("as a PDF with pages and with layers, in %s", (locale) => {
    expect(isPdf(renderReportPdf(doc(), "pages", locale))).toBe(true);
    expect(isPdf(renderReportPdf(doc(), "layers", locale))).toBe(true);
  });

  it.each(["en", "ar"] as const)("as Excel, in %s", async (locale) => {
    const x = await renderReportExcel(doc(), locale);
    expect(x.subarray(0, 2).toString()).toBe("PK");
  });

  it("in chapters with a lead section and the design style", async () => {
    const chaptered = doc({
      design: true,
      lead: [{ kind: "note", heading: "Summary", text: "Lead section." }],
      chapters: [
        { name: "Findings", summary: "What the data shows", sections: sections.slice(0, 12) },
        { name: "Detail", summary: "Per domain", sections: sections.slice(12) },
      ],
    });
    expect(isPdf(renderReportPdf(chaptered, "pages", "ar"))).toBe(true);
    expect(isPdf(renderReportPdf(chaptered, "layers", "en"))).toBe(true);
    expect((await renderReportExcel(chaptered, "ar")).subarray(0, 2).toString()).toBe("PK");
  });

  it("refuses a link to a page the document does not contain", () => {
    const broken = doc({ sections: [{ kind: "navGrid", heading: "Domains", tiles: [{ label: "Health", sub: "", to: "nowhere" }] }] });
    expect(() => renderReportPdf(broken)).toThrow(/unknown anchor "nowhere"/);
  });

  it("a document with no drill links is drawn in a single pass", () => {
    const flat = doc({ sections: [{ kind: "note", heading: "Only", text: "One section." }] });
    expect(isPdf(renderReportPdf(flat))).toBe(true);
  });
});
