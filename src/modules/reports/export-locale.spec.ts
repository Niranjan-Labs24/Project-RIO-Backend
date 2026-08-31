import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { StubReportDataProvider } from "./providers/__fixtures__/report-content.fixtures";
import { buildExportStub, type ExportAuditMeta } from "./reports.placeholder";
import { MESSAGES } from "../../i18n/messages";
import { latinRuns } from "../ai/language/detect-script";

/**
 * RIO-I18N-003 §10.5 — the export-time locale.
 *
 * The property under test is not "Arabic words appear". It is that ONE approved
 * report renders as two language editions with IDENTICAL FIGURES, because the
 * locale only reaches the rendering layer and never the stored content
 * (RIO-RPT-001 AC 2/AC 3). That is what lets a single review cycle produce both
 * files, and it is the assertion that would catch someone "fixing" this by
 * regenerating the report per language.
 */

const auditMeta: ExportAuditMeta = {
  generatedAt: "2026-07-22T10:30:00Z",
  status: "released",
  studyTitle: "Village Community Needs Assessment",
  generatedByName: "Research Officer - Demo User",
  officerConfirmedByName: "Research Officer - Demo User",
  officerConfirmedAt: "2026-07-22T09:30:00Z",
  reviewedByName: "Reviewer - Demo User",
  reviewedByRole: "Human Reviewer",
  reviewedAt: "2026-07-22T10:20:00Z",
  archivedAt: null,
  methodologyVersion: "v1.0",
};

async function villageContent(): Promise<Record<string, unknown>> {
  const c = await new StubReportDataProvider().getVillageReport({
    studyId: "s", villageId: "VIL-001", orgId: "o", filters: {},
  });
  return c as unknown as Record<string, unknown>;
}

const report = (content: Record<string, unknown>) => ({
  id: "rpt-1",
  title: "Village Report — Sample Village",
  reportType: "RPT14",
  content,
});

/** Every cell of every sheet, as strings — the workbook's full text surface. */
async function readAllCells(body: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body as unknown as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        const v = cell.value;
        if (v === null || v === undefined) return;
        out.push(typeof v === "object" ? JSON.stringify(v) : String(v));
      });
    });
  });
  return out;
}

/** Numbers a reader would compare between two editions of the same report. */
function numbersIn(cells: string[]): string[] {
  return cells
    .flatMap((c) => c.match(/\d[\d,.]*/g) ?? [])
    .map((n) => n.replace(/[,.]+$/, ""))
    .sort();
}

describe("export locale — Excel", () => {
  it("names the two language editions differently", async () => {
    const content = await villageContent();
    const en = await buildExportStub("excel", report(content), auditMeta, "en");
    const ar = await buildExportStub("excel", report(content), auditMeta, "ar");
    expect(en.filename).toBe("RPT14-rpt-1-en.xlsx");
    expect(ar.filename).toBe("RPT14-rpt-1-ar.xlsx");
  });

  it("defaults to English when no locale is given", async () => {
    // Every pre-existing caller passes no locale. They must keep behaving
    // exactly as before rather than silently acquiring a direction.
    const content = await villageContent();
    const { filename } = await buildExportStub("excel", report(content), auditMeta);
    expect(filename).toBe("RPT14-rpt-1-en.xlsx");
  });

  it("renders the Arabic edition right-to-left, and the English edition not", async () => {
    const content = await villageContent();
    const ar = await buildExportStub("excel", report(content), auditMeta, "ar");
    const en = await buildExportStub("excel", report(content), auditMeta, "en");

    const load = async (body: Buffer) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(body as unknown as ArrayBuffer);
      return wb;
    };

    const arWb = await load(ar.body);
    expect(arWb.worksheets.length).toBeGreaterThan(0);
    // EVERY sheet, not just the first — the direction pass runs over the whole
    // workbook precisely so a newly added sheet cannot be missed.
    for (const ws of arWb.worksheets) {
      expect((ws.views ?? []).some((v) => v.rightToLeft === true), ws.name).toBe(true);
    }

    // `views` comes back null when nothing set it, which is the correct English
    // state — absent, not explicitly left-to-right.
    const enWb = await load(en.body);
    for (const ws of enWb.worksheets) {
      expect((ws.views ?? []).every((v) => v.rightToLeft !== true), ws.name).toBe(true);
    }
  });

  it("translates the audit header and stamps which edition the file is", async () => {
    const content = await villageContent();
    const { body } = await buildExportStub("excel", report(content), auditMeta, "ar");
    const cells = await readAllCells(body);

    expect(cells).toContain(MESSAGES.ar["audit.generatedAt"]);
    expect(cells).toContain(MESSAGES.ar["audit.reviewedBy"]);
    // The language stamp: a shared file must say what it is without the reader
    // opening the other edition to compare.
    expect(cells).toContain(MESSAGES.ar["audit.exportLanguage"]);
    expect(cells).toContain(MESSAGES.ar["audit.language.ar"]);
    // And the English labels it replaced are gone.
    expect(cells).not.toContain("Generated At");
    expect(cells).not.toContain("Reviewed By");
  });

  it("keeps the back-links working when the Summary sheet is renamed", async () => {
    // The regression this guards: the back-link used to reference the literal
    // "Summary". Translating the sheet name without translating the link would
    // leave every "back" in the workbook pointing at a sheet that no longer
    // exists — a broken workbook that still opens, which is the worst kind.
    const content = await villageContent();
    const { body } = await buildExportStub("excel", report(content), auditMeta, "ar");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as unknown as ArrayBuffer);

    const summaryName = MESSAGES.ar["sheet.summary"];
    expect(wb.getWorksheet(summaryName)).toBeDefined();

    const names = new Set(wb.worksheets.map((w) => w.name));
    const cells = await readAllCells(body);
    for (const cell of cells) {
      const target = cell.match(/HYPERLINK\("#'([^']+)'!/)?.[1];
      if (target) expect(names.has(target.replace(/''/g, "'")), target).toBe(true);
    }
  });

  it("produces identical figures in both editions", async () => {
    // The core guarantee of export-time locale. If this ever fails, the locale
    // has leaked into generation and one approval no longer covers both files.
    const content = await villageContent();
    const en = await buildExportStub("excel", report(content), auditMeta, "en");
    const ar = await buildExportStub("excel", report(content), auditMeta, "ar");

    const enNumbers = numbersIn(await readAllCells(en.body));
    const arNumbers = numbersIn(await readAllCells(ar.body));
    expect(arNumbers).toEqual(enNumbers);
  });
});

describe("export locale — Arabic PDF", () => {
  it("renders Arabic with an embedded font instead of substitution marks", async () => {
    // This test previously asserted the OPPOSITE — that Arabic came out as
    // "?????" — as a tripwire for the renderer swap (RIO-NFR-007). The swap has
    // landed, so the assertion is inverted: Arabic PDFs now go through
    // pdf/unicode-pdf-builder.ts with Noto Naskh embedded.
    const content = await villageContent();
    const { body } = await buildExportStub("pdf", report(content), auditMeta, "ar");
    const raw = body.toString("latin1");

    expect(raw.startsWith("%PDF-1.")).toBe(true);
    // A real embedded TrueType CID font, not one of the base-14 faces.
    expect(raw).toContain("FontFile2");
    expect(raw).toContain("Identity-H");
    // The failure mode this replaced: runs of substitution marks where Arabic
    // should be.
    expect(/\?{3,}/.test(raw)).toBe(false);
  });

  it("puts readable Arabic and Latin text in the file", async () => {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const content = await villageContent();
    const { body } = await buildExportStub("pdf", report(content), auditMeta, "ar");
    const pdf = await getDocumentProxy(new Uint8Array(body));
    const { text } = await extractText(pdf, { mergePages: true });

    // Arabic survives as Arabic — shaping and ToUnicode both intact.
    expect((text.match(/[؀-ۿ]/g) ?? []).length).toBeGreaterThan(100);
    // Latin runs are drawn in Helvetica and stay selectable/searchable, which
    // they were not when the Arabic face was used for everything.
    expect(text).toMatch(/[A-Za-z]{4,}/);
  }, 20_000);

  it("is navigable: a contents page of links, and a way back from each section", async () => {
    // The English edition reveals chapters as PDF optional-content layers
    // (/OCG + /SetOCGState), which pdfkit cannot emit. The Arabic edition gives
    // the same navigation with real pages and link annotations, which works in
    // every viewer and prints correctly. What matters is that it IS navigable,
    // not which mechanism does it.
    const { getDocumentProxy } = await import("unpdf");
    const content = await villageContent();
    const { body } = await buildExportStub("pdf", report(content), auditMeta, "ar");
    const pdf = await getDocumentProxy(new Uint8Array(body));

    // Contents page plus one page per chapter.
    expect(pdf.numPages).toBeGreaterThan(1);

    let links = 0;
    let dead = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      for (const a of await page.getAnnotations()) {
        if (a.subtype !== "Link") continue;
        links++;
        // A link with no destination is a dead click in every viewer — worse
        // than plain text, because it looks actionable.
        if (!a.dest) dead++;
      }
    }
    expect(links).toBeGreaterThan(0);
    expect(dead).toBe(0);
  }, 20_000);

  it("makes the Arabic text searchable and copyable", async () => {
    // Two things break glyph-level extraction of shaped Arabic, and the
    // renderer works around both (see drawSearchLayer): glyphs with no reverse
    // code-point mapping, and RTL glyphs emitted in visual order. Without the
    // workaround a search for a word is matched against that word backwards,
    // with control characters mixed in.
    const { extractText, getDocumentProxy } = await import("unpdf");
    const content = await villageContent();
    const { body } = await buildExportStub("pdf", report(content), auditMeta, "ar");
    const pdf = await getDocumentProxy(new Uint8Array(body));
    const { text } = await extractText(pdf, { mergePages: true });

    // Single words AND multi-word phrases — the phrase is the harder case,
    // because it also requires the spaces to survive.
    expect(text).toContain(MESSAGES.ar["label.contents"]);
    expect(text).toContain(MESSAGES.ar["sheet.summary"]);
    expect(text).toContain("تقرير القرية");
  }, 20_000);

  it("still renders the English edition correctly", async () => {
    // The gap is Arabic-only; English PDF export must be untouched by all this.
    const content = await villageContent();
    const { body } = await buildExportStub("pdf", report(content), auditMeta, "en");
    const text = body.toString("latin1");
    expect(text.startsWith("%PDF-1.")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("Generated At");
    expect(latinRuns("Generated At").length).toBeGreaterThan(0);
  });
});
