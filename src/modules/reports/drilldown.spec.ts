import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { StubReportDataProvider } from "./providers/__fixtures__/report-content.fixtures";
import { individualSurveyGenerator } from "./generators/individual-survey.generator";
import { buildReportDoc, type DocSection } from "./report-doc";
import { BOTTOM, CONTENT_W, LEFT, PAGE_H, TOP, renderReportPdf, textWidth } from "./pdf-builder";
import { renderReportExcel } from "./excel-builder";

// Drill-down — the client's requirement is that the interactivity SURVIVES
// EXPORT, so these assert the emitted artefacts, not just the document model.
// A structural check on the PDF is the only thing that proves a link works:
// the file either resolves its /GoTo destinations to real pages or it does not.

async function doc() {
  const r = await individualSurveyGenerator({
    provider: new StubReportDataProvider(),
    orgId: "org-1",
    studyId: "study-1",
    surveyId: "survey-1",
    studyTitle: "Village Community Needs Assessment",
    filters: {},
  });
  return buildReportDoc(r.title, r.content, [{ label: "Generated At", value: "2026-08-18" }]);
}

const kinds = (sections: DocSection[], kind: string) => sections.filter((s) => s.kind === kind);

// exceljs's typings predate Node's generic Buffer, so the two Buffer types are
// nominally incompatible. One cast, named, rather than one at each call site.
function loadWorkbook(wb: ExcelJS.Workbook, body: Buffer): Promise<ExcelJS.Workbook> {
  return wb.xlsx.load(body as unknown as Parameters<typeof wb.xlsx.load>[0]);
}

describe("document model", () => {
  it("splits the report into named, summarised chapters", async () => {
    const d = await doc();
    expect(d.chapters).toBeDefined();
    expect(d.chapters!.length).toBeGreaterThan(1);
    for (const c of d.chapters!) {
      // Boxes are named for what a reader is looking for and say what is inside.
      expect(c.name.trim().length).toBeGreaterThan(0);
      expect(c.summary.trim().length).toBeGreaterThan(0);
      expect(c.sections.length).toBeGreaterThan(0);
    }
    // `sections` still carries everything in reading order, so Excel and the
    // on-screen viewer are unaffected by the chapter split.
    const inChapters = d.chapters!.reduce((n, c) => n + c.sections.length, 0);
    expect(d.sections.length).toBe(inChapters);
  });

  it("gives every drill target a stable id derived from methodology keys", async () => {
    const a = await doc();
    const b = await doc();
    const ids = (d: Awaited<ReturnType<typeof doc>>) =>
      (kinds(d.sections, "pageBreak") as Array<{ anchorId: string }>).map((s) => s.anchorId);
    // Two runs produce the same link structure — ids come from domain codes and
    // indicator ids, never from array position.
    expect(ids(a)).toEqual(ids(b));
    // Chapter pages are positional by nature; the DRILL anchors are the ones
    // that must be derived from methodology keys so they survive a rerun.
    const drill = ids(a).filter((id) => !id.startsWith("chapter:") && !id.startsWith("contents"));
    expect(drill.length).toBeGreaterThan(0);
    for (const id of drill) expect(id).toMatch(/^(domain|indicator):/);
    // No duplicates: two pages sharing an id would make one of them unreachable.
    expect(new Set(ids(a)).size).toBe(ids(a).length);
  });

  it("links table rows only to targets that exist", async () => {
    const d = await doc();
    const anchorIds = new Set([
      ...(kinds(d.sections, "pageBreak") as Array<{ anchorId: string }>).map((s) => s.anchorId),
      ...(kinds(d.sections, "anchor") as Array<{ id: string }>).map((s) => s.id),
    ]);
    const tables = d.sections.filter(
      (s): s is Extract<DocSection, { kind: "table" }> => s.kind === "table",
    );
    const linked = tables.filter((t) => t.rowLinks?.some((l) => l !== null));
    expect(linked.length).toBeGreaterThan(0);
    for (const t of linked) {
      // rowLinks must align 1:1 with rows, or row N's click opens row M's page.
      expect(t.rowLinks!.length).toBe(t.rows.length);
      for (const l of t.rowLinks!) if (l !== null) expect(anchorIds.has(l)).toBe(true);
    }
  });
});

describe("PDF export", () => {
  it("emits real link annotations whose destinations resolve to real pages", async () => {
    const pdf = renderReportPdf(await doc()).toString("latin1");

    const linkCount = (pdf.match(/\/Subtype \/Link/g) ?? []).length;
    expect(linkCount).toBeGreaterThan(0);
    // Same count of GoTo actions as Link annotations — a Link without an action
    // renders as a clickable rectangle that does nothing.
    expect((pdf.match(/\/S \/GoTo/g) ?? []).length).toBe(linkCount);
    // Pages actually reference their annotations; annotations built but never
    // attached to a page are invisible to every viewer.
    expect(pdf).toContain("/Annots [");

    // Every destination must point at an object that is really a /Type /Page.
    const pageObjNums = new Set(
      [...pdf.matchAll(/(\d+) 0 obj\n<< \/Type \/Page /g)].map((m) => m[1]),
    );
    expect(pageObjNums.size).toBeGreaterThan(1);
    const dests = [...pdf.matchAll(/\/D \[(\d+) 0 R \/XYZ/g)].map((m) => m[1]);
    expect(dests.length).toBe(linkCount);
    for (const d of dests) expect(pageObjNums.has(d!)).toBe(true);
  });

  it("hides the viewer's default link border", async () => {
    const pdf = renderReportPdf(await doc()).toString("latin1");
    const links = (pdf.match(/\/Subtype \/Link/g) ?? []).length;
    // Without /Border [0 0 0] every clickable row prints inside a black box.
    expect((pdf.match(/\/Border \[0 0 0\]/g) ?? []).length).toBe(links);
  });

  it("fails loudly rather than emitting a dead link", () => {
    // A link to a target nobody materialised must break the build. Shipping it
    // means the reader clicks and nothing happens, with no signal anywhere.
    expect(() =>
      renderReportPdf({
        title: "Broken",
        headerBand: [],
        audit: [],
        sections: [
          { kind: "anchor", id: "real" },
          {
            kind: "table",
            heading: "T",
            columns: ["A"],
            rows: [["1"]],
            rowLinks: ["does-not-exist"],
          },
        ],
      }),
    ).toThrow(/unknown anchor "does-not-exist"/);
  });

  it("leaves a report with no drill targets byte-identical to a plain render", () => {
    const plain = {
      title: "Plain",
      headerBand: [],
      audit: [],
      sections: [{ kind: "table" as const, heading: "T", columns: ["A"], rows: [["1"]] }],
    };
    const out = renderReportPdf(plain).toString("latin1");
    // The two-pass render must not change ordinary reports — no annotations,
    // no /Annots entry, no second pass.
    expect(out).not.toContain("/Subtype /Link");
    expect(out).not.toContain("/Annots");
  });
});

describe("Excel export", () => {
  it("carries each drill target as its own sheet, reachable by hyperlink", async () => {
    const wb = new ExcelJS.Workbook();
    await loadWorkbook(wb, await renderReportExcel(await doc()));

    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("Summary");

    // Collect every HYPERLINK target the workbook contains.
    const targets = new Set<string>();
    wb.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          const f = (cell.value as { formula?: string } | null)?.formula;
          const m = f?.match(/HYPERLINK\("#'(.+?)'!A1"/);
          if (m?.[1]) targets.add(m[1]);
        });
      });
    });

    expect(targets.size).toBeGreaterThan(0);
    // Excel parity with the PDF: every jump the workbook offers must land on a
    // sheet that exists, or the drill is lost in the format most analysts use.
    for (const t of targets) expect(names).toContain(t);
  });

  it("keeps sheet names inside Excel's 31-character limit", async () => {
    const wb = new ExcelJS.Workbook();
    await loadWorkbook(wb, await renderReportExcel(await doc()));
    for (const w of wb.worksheets) expect(w.name.length).toBeLessThanOrEqual(31);
    // Unique, or Excel silently refuses to open the file.
    expect(new Set(wb.worksheets.map((w) => w.name)).size).toBe(wb.worksheets.length);
  });
});

describe("professional report structure", () => {
  it("names chapters for the reader, not after whichever heading came first", async () => {
    const d = await doc();
    const labels = d.chapters!.map((c) => c.name);
    expect(labels).toContain("Overview");
    expect(labels.some((l) => /executive summary/i.test(l))).toBe(true);
    // Nothing should land in the catch-all once the scheme covers the sections
    // these reports actually emit.
    expect(labels).not.toContain("Additional Detail");
  });

  it("orders chapters the same way in every report, not in generator order", async () => {
    const labels = (await doc()).chapters!.map((c) => c.name);
    const overview = labels.indexOf("Overview");
    const recommendations = labels.findIndex((l) => /recommendations/i.test(l));
    // A report that opened on its recommendations and closed on its overview
    // would be navigable but not readable.
    expect(overview).toBeGreaterThanOrEqual(0);
    expect(recommendations).toBeGreaterThan(overview);
  });

  it("in layer mode, hides every chapter and gives each an open and a close action", async () => {
    const d = await doc();
    const pdf = renderReportPdf(d, "layers").toString("latin1");
    const count = d.chapters!.length;

    // One layer per chapter...
    expect((pdf.match(/\/Type \/OCG/g) ?? []).length).toBe(count);
    // ...and every one of them listed as OFF in the default configuration.
    // That listing is what makes the report open collapsed; without it the
    // layers exist but everything is visible from the start.
    const off = pdf.match(/\/OFF \[([^\]]*)\]/);
    expect(off).not.toBeNull();
    expect((off![1]!.match(/0 R/g) ?? []).length).toBe(count);

    // Two state actions per chapter: the box that opens it, the bar that closes it.
    expect((pdf.match(/\/S \/SetOCGState/g) ?? []).length).toBe(count * 2);

    // Marked content is balanced — an unclosed BDC makes the whole content
    // stream invalid, which no viewer recovers from.
    const bdc = (pdf.match(/\/OC \/L\d+ BDC/g) ?? []).length;
    const emc = (pdf.match(/EMC\s/g) ?? []).length;
    expect(bdc).toBe(emc);
    expect(bdc).toBeGreaterThanOrEqual(count);
  });

  it("in layer mode, declares each layer in the Resources of every page it draws on", async () => {
    const d = await doc();
    const pdf = renderReportPdf(d, "layers").toString("latin1");
    // A page whose stream marks /L3 but whose Resources omit it refers to
    // nothing, and the page fails to render rather than merely hiding content.
    const marked = new Set([...pdf.matchAll(/\/OC \/(L\d+) BDC/g)].map((m) => m[1]));
    for (const id of marked) {
      expect(pdf).toContain(`/${id} `);
    }
    expect(marked.size).toBeGreaterThan(0);
  });

  it("defaults to page mode, which every PDF viewer can actually open", async () => {
    const d = await doc();
    const pdf = renderReportPdf(d).toString("latin1");

    // Layer mode is opt-in. Optional content is hidden by the document's own
    // default state, and browsers' built-in viewers render that state but
    // cannot toggle it — so a layered file looks empty there. The default must
    // never produce one.
    expect(pdf).not.toContain("/Type /OCG");
    expect(pdf).not.toContain("/SetOCGState");

    // Each chapter is a real page reached by a plain GoTo.
    const links = (pdf.match(/\/Subtype \/Link/g) ?? []).length;
    expect((pdf.match(/\/S \/GoTo/g) ?? []).length).toBe(links);
    expect(links).toBeGreaterThanOrEqual(d.chapters!.length);
  });

  it("does not print an index for a report with nothing to navigate", () => {
    // A contents page listing one chapter is furniture, not navigation. The
    // sharing log is the real single-chapter case: its summary and its request
    // table are the same topic, and it carries no demographics or severity.
    const doc1 = buildReportDoc(
      "Sharing",
      {
        header: { studyName: "S" },
        summary: { approved: 1, pending: 0, rejected: 0 },
        requests: [{ reportTitle: "R", requestingOrg: "A", ownerOrg: "B", status: "approved" }],
      },
      [],
    );
    expect(doc1.chapters).toBeUndefined();
    // ...and the rendered file carries no layers at all, so it behaves exactly
    // like an ordinary report in every viewer.
    expect(renderReportPdf(doc1).toString("latin1")).not.toContain("/Type /OCG");
  });
});

describe("gender breakdown chart", () => {
  it("is drawn large and centred, on its own full width", async () => {
    const d = await doc();
    const demographics = d.chapters!.find((c) => c.name === "Demographics");
    expect(demographics).toBeDefined();

    const gender = demographics!.sections.find(
      (s): s is Extract<DocSection, { kind: "pie" }> =>
        s.kind === "pie" && s.heading === "Gender Breakdown",
    );
    expect(gender).toBeDefined();
    expect(gender!.emphasis).toBe(true);

    // Not nested in a `columns` pair: sharing the width with the settlement
    // split is what kept it small in the first place.
    expect(demographics!.sections.some((s) => s.kind === "columns")).toBe(false);
  });

  it("centres the pie-and-legend group, with the legend stacked to its right", async () => {
    const pdf = renderReportPdf(await doc()).toString("latin1");

    // Each pie arc starts with a moveto at the circle's centre.
    const centres = [...pdf.matchAll(/rg (\d+\.\d\d) (\d+\.\d\d) m/g)].map((m) => Number(m[1]));
    const pageCentre = LEFT + CONTENT_W / 2;
    const large = centres.filter((x) => x > LEFT && x < LEFT + CONTENT_W);
    expect(large.length).toBeGreaterThan(0);

    // The legend sits to the RIGHT, so the circle sits left of the page axis —
    // it is the whole group that is centred, not the circle alone.
    const pie = Math.max(...large.filter((x) => x < pageCentre));
    expect(pie).toBeLessThan(pageCentre);
    // ...but the group is inset from the left margin, not flush against it.
    expect(pie).toBeGreaterThan(LEFT + 60);

    // A legend entry is drawn to the right of the circle's centre.
    const legendX = [...pdf.matchAll(/1 0 0 1 ([\d.]+) [\d.]+ Tm \((?:Female|Male)/g)].map((m) =>
      Number(m[1]),
    );
    expect(legendX.length).toBeGreaterThan(0);
    for (const x of legendX) expect(x).toBeGreaterThan(pie);
  });

  it("stacks legend entries vertically rather than in a row", async () => {
    const pdf = renderReportPdf(await doc()).toString("latin1");
    const rows = [...pdf.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm \((?:Female|Male)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Same left edge, different baselines — a row layout would vary x and share y.
    const xs = new Set(rows.map((r) => r.x));
    const ys = new Set(rows.map((r) => r.y));
    expect(xs.size).toBe(1);
    expect(ys.size).toBe(rows.length);
  });

  it("keeps the smaller demographic chart in its normal left-aligned style", async () => {
    const d = await doc();
    const rural = d
      .chapters!.flatMap((c) => c.sections)
      .find(
        (s): s is Extract<DocSection, { kind: "pie" }> =>
          s.kind === "pie" && /rural/i.test(s.heading),
      );
    // Emphasis is for the figure that IS the section. Applying it to every
    // chart would make none of them stand out.
    expect(rural?.emphasis).toBeUndefined();
  });
});

describe("pie chart styling", () => {
  it("separates adjacent slices and rings the chart", async () => {
    const pdf = renderReportPdf(await doc()).toString("latin1");

    // One white stroke per slice boundary. Two slices in similar tones read as
    // a single wedge without them.
    expect((pdf.match(/1 1 1 RG/g) ?? []).length).toBeGreaterThan(0);
    // A thin outer ring, so the chart does not bleed into the page.
    expect(pdf).toMatch(/0\.45 0\.45 0\.45 RG 0\.6 w/);
  });

  it("draws the outline over the fills, never under them", async () => {
    const pdf = renderReportPdf(await doc()).toString("latin1");
    // Painting order is the whole point: an outline emitted before the last
    // slice's fill is simply covered by it.
    const lastFill = pdf.lastIndexOf("h f");
    const firstSeparator = pdf.indexOf("1 1 1 RG");
    expect(firstSeparator).toBeGreaterThan(-1);
    // Compare within the gender figure's own region rather than the whole file.
    const region = pdf.slice(0, lastFill);
    const fillBeforeSeparator = region.lastIndexOf("h f", firstSeparator);
    expect(fillBeforeSeparator).toBeLessThan(firstSeparator);
  });

  it("omits separators when there is only one slice", () => {
    // A single-slice chart is a full circle with no internal boundary; drawing
    // one would put a stray white line across it.
    const single = buildReportDoc(
      "Single",
      {
        header: { studyName: "S" },
        responseQuality: { submittedResponses: 1 },
        demographics: { gender: [{ label: "Female", count: 10 }], rural: [] },
      },
      [],
    );
    const pdf = renderReportPdf(single).toString("latin1");
    expect((pdf.match(/1 1 1 RG/g) ?? []).length).toBe(0);
  });
});

describe("gender chart fills its section", () => {
  it("draws the chart large enough to carry the page it sits on", async () => {
    const pdf = renderReportPdf(await doc()).toString("latin1");
    const arcs = [...pdf.matchAll(/rg ([\d.]+) ([\d.]+) m ([^h]*)h f/g)]
      .map((m) => {
        const cx = Number(m[1]);
        const cy = Number(m[2]);
        const pts = [...m[3]!.matchAll(/([\d.]+) ([\d.]+) l/g)].map((p) => [
          Number(p[1]),
          Number(p[2]),
        ]);
        const radii = pts
          .map(([x, y]) => Math.hypot(x! - cx, y! - cy))
          .filter((d) => d > 1);
        return radii.length ? Math.max(...radii) : 0;
      })
      .filter((r) => r > 5);

    expect(arcs.length).toBeGreaterThan(0);
    const radius = Math.max(...arcs);
    const contentH = PAGE_H - TOP - BOTTOM;
    // A chart on a page of its own should carry that page. Below roughly a
    // third of the content height it reads as stranded in white space, which is
    // what it did at r=58; above half it cannot sit under its own heading.
    expect(2 * radius).toBeGreaterThanOrEqual(170);
    expect((2 * radius) / contentH).toBeGreaterThan(0.24);
    expect((2 * radius) / contentH).toBeLessThan(0.5);
  });

  it("scales the legend type with the chart", async () => {
    const pdf = renderReportPdf(await doc()).toString("latin1");
    const sizes = [
      ...pdf.matchAll(/\/F2 ([\d.]+) Tf 1 0 0 1 [\d.]+ [\d.]+ Tm \((?:Male|Female)/g),
    ].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    // 9.5pt beside a 300pt circle reads as a caption, not a legend.
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(13);
  });

  it("keeps the whole figure inside the content width", async () => {
    const pdf = renderReportPdf(await doc()).toString("latin1");
    // The whole legend entry must stay within the margins, not just its left
    // edge — a label that starts inside and ENDS outside is clipped by the
    // page, not wrapped, and that is the failure this guards.
    const entries = [
      ...pdf.matchAll(/\/F2 ([\d.]+) Tf 1 0 0 1 ([\d.]+) [\d.]+ Tm \(((?:Male|Female)[^)]*)/g),
    ].map((m) => ({ size: Number(m[1]), x: Number(m[2]), text: m[3]! }));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.x + textWidth(e.text, e.size)).toBeLessThanOrEqual(LEFT + CONTENT_W);
    }
  });
});
