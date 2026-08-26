// One-off: regenerate the RPT04 Domain-wise Needs sample exports from the stub
// content, so the files under `md files/report-samples/` show what the report
// now renders (Needs Index gauge, Max KPI Severity, Scope Basis, masking alert).
import { writeFileSync } from "node:fs";
import { sectorGenerator } from "../src/modules/reports/generators/sector.generator";
import { StubReportDataProvider } from "../src/modules/reports/providers/__fixtures__/report-content.fixtures";
import { buildExportStub, type ExportAuditMeta } from "../src/modules/reports/reports.placeholder";

const audit: ExportAuditMeta = {
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

async function main() {
  const { title, content } = await sectorGenerator({
    provider: new StubReportDataProvider(),
    orgId: "org-1",
    studyId: "study-1",
    filters: {},
  });

  for (const fmt of ["pdf", "excel"] as const) {
    const { body } = await buildExportStub(
      fmt,
      { id: "sample", title, reportType: "RPT04", content },
      audit,
    );
    const out = `../md files/report-samples/sector.${fmt === "pdf" ? "pdf" : "xlsx"}`;
    writeFileSync(out, body);
    console.log(`wrote ${out} (${body.length} bytes)`);
  }
}

void main();
