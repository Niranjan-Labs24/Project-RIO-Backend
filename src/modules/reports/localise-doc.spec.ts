import { describe, expect, it } from "vitest";
import { localiseReportDoc } from "./localise-doc";
import type { ReportDoc } from "./report-doc";

const base: ReportDoc = {
  title: "Domain-wise Needs Report — تقييم جودة التعليم",
  headerBand: [
    { label: "Study Name", value: "تقييم جودة التعليم" },
    { label: "Status", value: "released" },
  ],
  sections: [
    {
      kind: "keyvalue",
      heading: "Scope Basis",
      rows: [
        { label: "Selected by", value: "Latest published survey" },
        { label: "Surveys in study", value: "1" },
      ],
    },
    {
      kind: "table",
      heading: "Domains",
      columns: ["Domain", "Code", "Avg Severity", "Confidence", "Masking?"],
      rows: [["Education", "EDUCATION", "33.33", "LOW", "YES — read Max, not Avg"]],
    },
    {
      kind: "bars",
      heading: "Domain Severity (0-100)",
      max: 100,
      bars: [{ label: "Education", value: 33 }],
    },
    { kind: "list", heading: "Recommendations", items: ["Conduct further assessments."] },
    { kind: "note", heading: "Data Quality Note", text: "The confidence level is LOW." },
  ],
  audit: [{ label: "Reviewer Role", value: "Human Reviewer" }],
};

describe("localiseReportDoc", () => {
  it("is a no-op for English — the same object, not a copy", () => {
    expect(localiseReportDoc(base, "en")).toBe(base);
  });

  it("translates headings, row labels and column headers", () => {
    const doc = localiseReportDoc(base, "ar");
    expect(doc.sections[0]!).toMatchObject({ heading: "أساس النطاق" });
    expect((doc.sections[0]! as { rows: Array<{ label: string }> }).rows[0]!.label).toBe("اختير بواسطة");
    const table = doc.sections[1]! as { heading: string; columns: string[] };
    expect(table.heading).toBe("المجالات");
    expect(table.columns).toEqual(["المجال", "الرمز", "متوسط الشدة", "مستوى الثقة", "إخفاء؟"]);
    expect(doc.headerBand[0]!.label).toBe("اسم الدراسة");
    expect(doc.audit[0]!.label).toBe("دور المراجع");
  });

  it("translates closed-vocabulary values but leaves data alone", () => {
    const doc = localiseReportDoc(base, "ar");
    const row = (doc.sections[1]! as { rows: string[][] }).rows[0]!;
    // "Education" and "EDUCATION" are reference data — they stay until the
    // catalogue grows a nameAr column. "33.33" is a figure.
    expect(row[0]).toBe("Education");
    expect(row[1]).toBe("EDUCATION");
    expect(row[2]).toBe("33.33");
    // "LOW" and the masking note are OUR rendering of an enum.
    expect(row[3]).toBe("منخفض");
    expect(row[4]).toBe("نعم — اقرأ الأعلى، لا المتوسط");
    expect(doc.headerBand[1]!.value).toBe("مُطلق");
  });

  it("never rewrites a data value that happens to match a chrome label", () => {
    // The failure mode a blanket string replace would have: a village or domain
    // legitimately named "Summary" or "Domain" must survive untouched.
    const doc = localiseReportDoc(
      {
        ...base,
        sections: [
          {
            kind: "table",
            heading: "Domains",
            columns: ["Domain"],
            rows: [["Summary"], ["Domain"], ["Coverage"]],
          },
        ],
      },
      "ar",
    );
    const rows = (doc.sections[0]! as { rows: string[][] }).rows;
    expect(rows).toEqual([["Summary"], ["Domain"], ["Coverage"]]);
    // ...while the COLUMN of the same name is translated, because that position
    // structurally holds chrome.
    expect((doc.sections[0]! as { columns: string[] }).columns).toEqual(["المجال"]);
  });

  it("leaves narrative prose and chart data labels untouched", () => {
    const doc = localiseReportDoc(base, "ar");
    // Recommendations and notes are model output — substituting them would be
    // inventing a translation.
    expect((doc.sections[3]! as { items: string[] }).items).toEqual([
      "Conduct further assessments.",
    ]);
    expect((doc.sections[4]! as { text: string }).text).toBe("The confidence level is LOW.");
    // A bar's label is a domain name, not chrome.
    expect((doc.sections[2]! as { bars: Array<{ label: string }> }).bars[0]!.label).toBe("Education");
    // ...but its heading is.
    expect(doc.sections[2]!.kind === "bars" && doc.sections[2]!.heading).toBe(
      "شدة المجال (0-100)",
    );
  });

  it("translates a composed title's chrome half and leaves the subject alone", () => {
    const doc = localiseReportDoc(base, "ar");
    // The study name is Arabic already and was written by its author; only the
    // report-type half is ours to translate.
    expect(doc.title).toBe("تقرير الاحتياجات حسب المجال — تقييم جودة التعليم");
  });

  it("translates chrome on either side of the em-dash", () => {
    // "<domain> — Domain Detail" puts the subject first; the title case puts it
    // second. Both must work, and neither may rewrite the subject.
    const doc = localiseReportDoc(
      { ...base, sections: [{ kind: "note", heading: "Education — Domain Detail", text: "x" }] },
      "ar",
    );
    expect(doc.sections[0]!.kind === "note" && doc.sections[0]!.heading).toBe(
      "Education — تفاصيل المجال",
    );
  });

  it("passes an unknown label through as English rather than blanking it", () => {
    const doc = localiseReportDoc(
      { ...base, sections: [{ kind: "note", heading: "Some Heading We Never Mapped", text: "x" }] },
      "ar",
    );
    expect(doc.sections[0]!.kind === "note" && doc.sections[0]!.heading).toBe(
      "Some Heading We Never Mapped",
    );
  });
});
