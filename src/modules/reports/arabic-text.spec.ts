import { describe, expect, it } from "vitest";
import { getArabicFont, hasArabic, shapeArabicAware } from "./arabic-text";
import { buildReportDoc } from "./report-doc";
import { renderReportPdf } from "./pdf-builder";

// Regression cover for the Arabic font loader.
//
// This existed unexercised for a long time: no test ever put Arabic text
// through a PDF render, because no fixture contained any. The first export that
// did — an e2e run after Arabic master data was seeded into the database —
// crashed with "Cannot read properties of undefined (reading 'openSync')",
// because `import fontkit from "fontkit"` asks for a default export the package
// does not have. Under the CommonJS build esModuleInterop papered over it; under
// ESM it threw, and a build-system change alone would have taken production
// with it.
//
// So the point of this file is coverage that the Arabic path is REACHED, not
// just that it is written.

const AR = "الرياض";

describe("Arabic font loading", () => {
  it("opens the embedded fonts", () => {
    // Directly pins the failure: getArabicFont() calls fontkit.openSync, which
    // was undefined.
    for (const weight of ["regular", "bold"] as const) {
      const loaded = getArabicFont(weight);
      expect(loaded.font, `${weight} font`).toBeDefined();
      expect(loaded.ttfByteLength).toBeGreaterThan(1000);
    }
  });

  it("caches the font across calls", () => {
    expect(getArabicFont("regular")).toBe(getArabicFont("regular"));
  });

  it("detects and shapes Arabic", () => {
    expect(hasArabic(AR)).toBe(true);
    expect(hasArabic("Riyadh")).toBe(false);

    const chunks = shapeArabicAware(AR, "regular");
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("PDF rendering with Arabic content", () => {
  it("renders a document whose labels and data are Arabic", () => {
    // The shape a real Arabic export has now: Arabic headings and labels from
    // the catalogue, Arabic master-data values from nameAr.
    const doc = buildReportDoc(
      "تقرير المسح الفردي",
      {
        header: { studyName: "تقييم الاحتياجات", entityName: "منظمة تجريبية" },
        summary: "ملخص تنفيذي للتقرير باللغة العربية.",
      },
      [{ label: "تاريخ الإنشاء", value: "08 Sep 2026, 10:30" }],
      "ar",
    );

    const pdf = renderReportPdf(doc);

    expect(pdf.subarray(0, 5).toString("latin1"), "PDF magic bytes").toBe("%PDF-");
    // An embedded font subset means the Arabic actually went through the
    // shaping path rather than being folded to "?" by the WinAnsi escape.
    expect(pdf.length).toBeGreaterThan(10_000);
  });

  it("still renders a purely English document", () => {
    const doc = buildReportDoc(
      "Individual Survey Report",
      { header: { studyName: "Ad-Dilam Baseline" }, summary: "An English summary." },
      [{ label: "Generated At", value: "08 Sep 2026, 10:30" }],
    );

    expect(renderReportPdf(doc).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders mixed Arabic and Latin in one line without throwing", () => {
    // Village names, acronyms and numbers stay Latin inside Arabic sentences —
    // the bidi path has to cope with both scripts in one run.
    const doc = buildReportDoc(
      "تقرير",
      { header: { studyName: "الرياض — Ad-Dilam (RPT01)" }, summary: "النتيجة 47.5% خلال 2026." },
      [],
      "ar",
    );

    expect(renderReportPdf(doc).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("RTL page direction", () => {
  const doc = (locale: "en" | "ar") =>
    buildReportDoc(
      "تقرير",
      {
        header: { studyName: "تقييم الاحتياجات" },
        summary: "ملخص",
        domains: [
          { name: "الصحة", severityScore: 72 },
          { name: "التعليم", severityScore: 48 },
        ],
      },
      [{ label: "تاريخ الإنشاء", value: "08 Sep 2026" }],
      locale,
    );

  it("produces a valid PDF in both directions", () => {
    for (const locale of ["en", "ar"] as const) {
      const pdf = renderReportPdf(doc(locale), "pages", locale);
      expect(pdf.subarray(0, 5).toString("latin1"), locale).toBe("%PDF-");
      expect(pdf.length, locale).toBeGreaterThan(5_000);
    }
  });

  it("lays the same document out differently right-to-left", () => {
    // The mirror is applied at the primitives, so an RTL render must not be
    // byte-identical to the LTR one. Identical output would mean `dir` never
    // reached them.
    const ltr = renderReportPdf(doc("ar"), "pages", "en");
    const rtl = renderReportPdf(doc("ar"), "pages", "ar");
    expect(rtl.equals(ltr)).toBe(false);
  });

  it("leaves English exports byte-identical to before", () => {
    // Default locale must be a true no-op: `mx()` is the identity in LTR, so
    // this is the guard that RTL work cannot regress every existing export.
    const a = renderReportPdf(doc("en"), "pages");
    const b = renderReportPdf(doc("en"), "pages", "en");
    expect(a.equals(b)).toBe(true);
  });
});

describe("shaping cache", () => {
  // An Arabic RPT01 render took 22 seconds against 1.5 for the English one, and
  // essentially all of it was re-shaping strings already shaped: wrap()/fits()
  // binary-search a line's width and re-shape on every probe, and the RTL
  // mirror measures each run again to place it. Memoising took the same render
  // to 97ms. Without a test this silently regresses the moment shaping gains a
  // parameter that is not part of the key.
  it("returns the identical result for a repeated string", () => {
    const s = "تقييم خدمات الرعاية الصحية الأولية";
    expect(shapeArabicAware(s, "regular")).toBe(shapeArabicAware(s, "regular"));
  });

  it("keeps weights apart", () => {
    const s = "الرياض";
    expect(shapeArabicAware(s, "regular")).not.toBe(shapeArabicAware(s, "bold"));
  });

  it("re-shapes an order of magnitude faster the second time", () => {
    const strings = Array.from({ length: 300 }, (_, i) => `تقييم رقم ${i} للخدمات`);

    const t0 = Date.now();
    for (const s of strings) shapeArabicAware(s, "regular");
    const cold = Date.now() - t0;

    const t1 = Date.now();
    for (const s of strings) shapeArabicAware(s, "regular");
    const warm = Date.now() - t1;

    // Deliberately loose — this asserts that a cache exists at all, not a
    // particular machine's speed.
    expect(warm).toBeLessThan(Math.max(20, cold / 5));
  });
});
