import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { MockReportApiClient } from "./providers/mock-report-api.client";
import { buildExportStub, type ExportAuditMeta } from "./reports.placeholder";

const auditMeta: ExportAuditMeta = {
  generatedAt: "2026-07-22T10:30:00Z",
  status: "released",
  studyTitle: "Village Community Needs Assessment",
  generatedByName: "Research Officer - Demo User",
  officerConfirmedByName: "Research Officer - Demo User",
  officerConfirmedAt: "2026-07-22T09:30:00Z",
  reviewedByName: "Reviewer - Demo User",
  reviewedAt: "2026-07-22T10:20:00Z",
  archivedAt: null,
};

async function villageContent(): Promise<Record<string, unknown>> {
  const c = await new MockReportApiClient().fetchVillageReport({
    studyId: "s", villageId: "VIL-001", orgId: "o", filters: {},
  });
  return c as unknown as Record<string, unknown>;
}

describe("report export rendering (Step 4)", () => {
  it("produces a structurally valid, non-trivial PDF with header/tables/charts/audit", async () => {
    const content = await villageContent();
    const { filename, contentType, body } = await buildExportStub(
      "pdf",
      { id: "rpt-1", title: "Village Report — Sample Village", reportType: "RPT14", content },
      auditMeta,
    );
    const text = body.toString("latin1");

    expect(contentType).toBe("application/pdf");
    expect(filename).toBe("RPT14-rpt-1.pdf");
    expect(text.startsWith("%PDF-1.")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // Vector bar-chart fills are present (rectangle fill operator).
    expect(text).toContain(" re f");
    // A real multi-section document, not a one-liner stub.
    expect(body.length).toBeGreaterThan(2000);
    // Section headings + the two-actor audit block render as PDF text.
    for (const needle of ["Village Report", "Domain Severity", "Priority", "Audit Trail", "Reviewer - Demo User"]) {
      expect(text).toContain(needle);
    }
  });

  it("produces an Excel workbook with a Summary, per-table sheets, and a data-bar chart", async () => {
    const content = await villageContent();
    const { contentType, body } = await buildExportStub(
      "excel",
      { id: "rpt-1", title: "Village Report — Sample Village", reportType: "RPT14", content },
      auditMeta,
    );
    expect(contentType).toContain("spreadsheetml");
    expect(body.subarray(0, 2).toString("latin1")).toBe("PK"); // xlsx = zip

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("Summary");
    expect(names.some((n) => n.startsWith("Domain Severity"))).toBe(true);
    expect(names).toContain("Top KPIs");

    // The bars sheet carries a data-bar conditional format (the in-cell chart).
    const bars = wb.worksheets.find((w) => w.name.startsWith("Domain Severity"))!;
    const cfs = (bars as unknown as { conditionalFormattings?: unknown[] }).conditionalFormattings ?? [];
    expect(cfs.length).toBeGreaterThan(0);
  });

  it("falls back to a generic structured export for placeholder report shapes", async () => {
    const content = { summary: "Placeholder", sections: [{ title: "Overview", content: "x" }], isPlaceholder: true };
    const { body } = await buildExportStub(
      "pdf",
      { id: "p", title: "Top Needs Report", reportType: "RPT03", content },
      auditMeta,
    );
    expect(body.toString("latin1").startsWith("%PDF-1.")).toBe(true);
    expect(body.length).toBeGreaterThan(1000);
  });
});
