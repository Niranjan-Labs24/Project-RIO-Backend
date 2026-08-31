// RPT04 Domain-wise Needs — the three checks RIO-RPT-001 assigned to this
// report and the suite never carried: reconciliation, export parity, and the
// methodology's no-masking rule.
//
// Each `it` here maps to a line in the plan rather than to a function, because
// what was wrong with RPT04 was never a function returning the wrong number —
// it was correct numbers that never reached the page.

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { sectorGenerator } from "./generators/sector.generator";
import { StubReportDataProvider } from "./providers/__fixtures__/report-content.fixtures";
import { deriveDomainMasking, groupKpisByDomain } from "./providers/derive-domain-masking";
import { buildReportDoc } from "./report-doc";
import { buildExportStub, type ExportAuditMeta } from "./reports.placeholder";
import type { SectorReportContent } from "./report-content.types";

const auditMeta: ExportAuditMeta = {
  generatedAt: "2026-07-22T10:30:00Z",
  status: "released",
  studyTitle: "Village Community Needs Assessment",
  generatedByName: "Data Analyst",
  officerConfirmedByName: "Research Officer - Demo User",
  officerConfirmedAt: "2026-07-22T09:30:00Z",
  reviewedByName: "Reviewer - Demo User",
  reviewedByRole: "Human Reviewer",
  reviewedAt: "2026-07-22T10:20:00Z",
  archivedAt: null,
  methodologyVersion: "v1.0",
};

async function sectorContent(): Promise<{ title: string; content: Record<string, unknown>; c: SectorReportContent }> {
  const { title, content } = await sectorGenerator({
    provider: new StubReportDataProvider(),
    orgId: "org-1",
    studyId: "study-1",
    filters: {},
  });
  return { title, content, c: content as unknown as SectorReportContent };
}

describe("RPT04 — the no-masking rule", () => {
  it("flags a domain whose average bands milder than its worst KPI", () => {
    const m = deriveDomainMasking(44, [
      { domainKey: "HEALTH", kpiName: "Clinic distance", severityScore: 86 },
      { domainKey: "HEALTH", kpiName: "Staffing", severityScore: 20 },
    ]);
    expect(m.maxKpiSeverity).toBe(86);
    expect(m.maxKpiName).toBe("Clinic distance");
    expect(m.criticalKpiCount).toBe(1);
    expect(m.masksCriticalFinding).toBe(true);
  });

  it("does not flag a domain already banded as severely as its worst KPI", () => {
    const m = deriveDomainMasking(81, [
      { domainKey: "WASH", kpiName: "Safe water access", severityScore: 88 },
    ]);
    // Both CRITICAL — a reader already sees the severity, nothing is hidden.
    expect(m.masksCriticalFinding).toBe(false);
    expect(m.maxKpiSeverity).toBe(88);
  });

  it("reports null — never 0 — for a domain with no measurable KPI", () => {
    const m = deriveDomainMasking(null, [
      { domainKey: "EDU", kpiName: "Pupil-teacher ratio", severityScore: null },
    ]);
    // 0 would read as "assessed, worst KPI is fine", the opposite of the truth.
    expect(m.maxKpiSeverity).toBeNull();
    expect(m.maxKpiName).toBeNull();
    expect(m.masksCriticalFinding).toBe(false);
  });

  it("groups KPIs by their normalized domain key", () => {
    const grouped = groupKpisByDomain([
      { domainKey: "HEALTH", kpiName: "a", severityScore: 10 },
      { domainKey: "WASH", kpiName: "b", severityScore: 20 },
      { domainKey: "HEALTH", kpiName: "c", severityScore: 30 },
    ]);
    expect(grouped.get("HEALTH")).toHaveLength(2);
    expect(grouped.get("WASH")).toHaveLength(1);
  });

  it("carries the max beside the average on every domain row of the report", async () => {
    const { c } = await sectorContent();
    expect(c.severity.domains.length).toBeGreaterThan(0);
    for (const d of c.severity.domains) {
      // The rule is "max ALONGSIDE average" — a row with one and not the other
      // is the defect, whichever one is missing.
      expect(d).toHaveProperty("severityScore");
      expect(d).toHaveProperty("maxKpiSeverity");
      expect(d).toHaveProperty("maxKpiName");
      expect(d).toHaveProperty("criticalKpiCount");
      expect(typeof d.masksCriticalFinding).toBe("boolean");
    }
  });
});

describe("RPT04 — reconciliation", () => {
  it("keeps the overall index under the key both renderers read", async () => {
    const { content, c } = await sectorContent();
    // Regression guard for the `overall` → `severity` rename: the block existed
    // all along under a key nothing looked at, so the gauge and band were
    // computed and then dropped from the PDF, the Excel and the screen.
    expect(content.severity).toBeDefined();
    expect(content.overall).toBeUndefined();
    expect(c.severity.overallVillageNeedsIndex).not.toBeNull();
    expect(c.severity.label).toBeTruthy();

    const doc = buildReportDoc("Domain-wise Needs Report", content, []);
    const gauges = doc.sections.filter((s) => s.kind === "gauge");
    const nestedGauges = doc.sections.flatMap((s) =>
      s.kind === "columns" ? s.children.filter((ch) => ch.kind === "gauge") : [],
    );
    expect(gauges.length + nestedGauges.length).toBeGreaterThan(0);
  });

  it("renders as a structured document, not the flat key-value fallback", async () => {
    const { content } = await sectorContent();
    const doc = buildReportDoc("Domain-wise Needs Report", content, []);
    const headings = doc.sections.map((s) => ("heading" in s ? s.heading : "")).filter(Boolean);
    expect(headings).toContain("Domains");
    // The flat fallback emits a single "Summary" blob and nothing else.
    expect(headings.length).toBeGreaterThan(1);
  });

  it("states which survey the study-scoped figures came from", async () => {
    const { content, c } = await sectorContent();
    expect(c.scopeBasis.surveyId).toBeTruthy();
    expect(c.scopeBasis.studySurveyCount).toBeGreaterThan(0);
    const doc = buildReportDoc("Domain-wise Needs Report", content, []);
    const headings = doc.sections.map((s) => ("heading" in s ? s.heading : ""));
    expect(headings).toContain("Scope Basis");
  });

  it("surfaces a Domain Masking Alert when a domain masks a critical KPI", async () => {
    const { content, c } = await sectorContent();
    const masked = c.severity.domains.filter((d) => d.masksCriticalFinding);
    expect(masked.length).toBeGreaterThan(0); // the fixture carries one on purpose
    const doc = buildReportDoc("Domain-wise Needs Report", content, []);
    const alert = doc.sections.find((s) => "heading" in s && s.heading === "Domains — Domain Masking Alert");
    expect(alert).toBeDefined();
    // The note must NAME the domain, or a reader still has to hunt for it.
    expect(alert && "text" in alert ? alert.text : "").toContain(masked[0]!.name);
  });
});

describe("RPT04 — export parity", () => {
  it("exports to PDF with the domain figures and the max-KPI column", async () => {
    const { title, content } = await sectorContent();
    const { filename, contentType, body } = await buildExportStub(
      "pdf",
      { id: "rpt-4", title, reportType: "RPT04", content },
      auditMeta,
    );
    const text = body.toString("latin1");

    expect(contentType).toBe("application/pdf");
    expect(filename).toBe("RPT04-rpt-4-en.pdf");
    expect(text.startsWith("%PDF-1.")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    for (const needle of ["Domain-wise Needs", "Domains", "Max KPI Severity", "Scope Basis", "Audit Trail"]) {
      expect(text).toContain(needle);
    }
  });

  it("exports the same report to Excel with the same domain rows", async () => {
    const { title, content, c } = await sectorContent();
    const { contentType, body } = await buildExportStub(
      "excel",
      { id: "rpt-4", title, reportType: "RPT04", content },
      auditMeta,
    );
    expect(contentType).toContain("spreadsheetml");

    const wb = new ExcelJS.Workbook();
    // See export.spec.ts for why this cast is needed (exceljs .d.ts vs
    // @types/node Buffer typing), not a runtime concern.
    await wb.xlsx.load(body as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("Summary");
    expect(names).toContain("Domains");

    // Parity is about FIGURES, not just sheet names: every domain in the
    // content must appear in the workbook, or the two exports disagree.
    const sheet = wb.worksheets.find((w) => w.name === "Domains")!;
    const flat: string[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => flat.push(String(cell.value ?? ""))));
    for (const d of c.severity.domains) {
      expect(flat).toContain(d.name);
    }
    expect(flat.some((v) => v.includes("Max KPI Severity"))).toBe(true);
  });
});
