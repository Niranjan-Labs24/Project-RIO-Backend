import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { orgContext } from "../../tenancy/org-context";
import { ReportsService } from "./reports.service";
import type { ReportRow } from "./reports.types";
import { fakeTx } from "./core-needs/__fixtures__/core-needs-db";
import { loadCoreNeedsInputs } from "./core-needs/load-core-needs";
import { buildCoreNeedsContent } from "./core-needs/build-core-needs";

// RPT18 through ReportsService: its scope options, the on-screen view and its
// own PDF and Excel export, for the organisation and for System Admin.

async function harness(status: ReportRow["status"] = "released") {
  const db = fakeTx();
  const inputs = await loadCoreNeedsInputs(db, { studyId: "s1", surveyId: "sv1", scopeLevel: "GOVERNORATE", unitId: "g1" });
  const content = buildCoreNeedsContent({ inputs, output: "FULL", domainKeys: null, filters: { scopeLevel: "GOVERNORATE", unitId: "g1" }, generatedAt: "2026-10-23T09:00:00Z" });
  const row: ReportRow = {
    id: "rpt-18",
    orgId: "o1",
    reportType: "RPT18",
    status,
    title: "Core Needs Report — Al-Ahsa",
    studyId: "s1",
    surveyId: "sv1",
    filters: content.filters,
    content: content as never,
    generatedBy: "analyst-1",
    generatedAt: new Date("2026-10-23T09:00:00Z"),
    officerConfirmedBy: "officer-1",
    officerConfirmedAt: new Date("2026-10-23T09:30:00Z"),
    reviewedBy: "reviewer-1",
    reviewedAt: new Date("2026-10-23T10:00:00Z"),
    reviewerNotes: "Checked against the study data.",
    archivedAt: null,
  };
  const tx = {
    ...(db as unknown as Record<string, unknown>),
    report: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === row.id ? row : null) },
    user: {
      findMany: async () => [
        { id: "analyst-1", name: "Data Analyst", roleId: "role_data_analyst" },
        { id: "reviewer-1", name: "Reviewer", roleId: "role_human_reviewer" },
      ],
    },
  };
  const tenant = { runInOrgContext: (fn: (t: unknown) => unknown) => fn(tx), runAsSupervisor: (fn: (t: unknown) => unknown) => fn(tx) };
  const audited: string[] = [];
  const audit = { record: async (e: { action: string }) => void audited.push(e.action) };
  const translation = {
    translate: async (text: string) => ({ translatedText: text, unchanged: true }),
    translateMany: async (texts: readonly string[]) => texts.map((t) => ({ translatedText: t, unchanged: true })),
  };
  const service = new ReportsService(tenant as never, audit as never, {} as never, {} as never, translation as never);
  return { service, audited };
}

const as = <T>(role: string, fn: () => Promise<T>, locale: "en" | "ar" = "en") =>
  orgContext.run({ requestId: "t", orgId: "o1", actorId: "actor-1", role, locale }, fn);

describe("RPT18 in ReportsService", () => {
  it("offers the study's areas, or every area of the organisation's studies", async () => {
    const { service } = await harness();
    const one = await as("data_analyst", () => service.coreScopeOptions("s1"));
    expect(one.governorates.map((g) => g.name)).toEqual(["Al-Ahsa", "Qatif"]);
    const all = await as("data_analyst", () => service.coreScopeOptions());
    expect(all.studyIds).toEqual(["s1"]);
  });

  it("opens with the report's own view in the reader's language", async () => {
    const { service } = await harness();
    const report = await as("data_analyst", () => service.getById("rpt-18"), "ar");
    const view = (report.content as { coreView: { dir: string; locale: string } }).coreView;
    expect(view).toMatchObject({ dir: "rtl", locale: "ar" });
  });

  it.each([
    ["data_analyst", "pdf", "en"],
    ["data_analyst", "excel", "ar"],
    ["system_admin", "pdf", "ar"],
  ] as const)("exports as %s to %s in %s, with its own design", async (role, format, locale) => {
    const { service, audited } = await harness();
    const file = await as(role, () => service.export("rpt-18", format, locale));
    expect(file.filename).toBe(`RPT18-rpt-18.${format === "pdf" ? "pdf" : "xlsx"}`);
    expect(file.body.subarray(0, format === "pdf" ? 5 : 2).toString()).toBe(format === "pdf" ? "%PDF-" : "PK");
    expect(audited).toContain(role === "system_admin" ? "SYSTEM_ADMIN_DOWNLOADED_REPORT" : "share");
  });

  it("exports only a released report", async () => {
    const { service } = await harness("draft");
    await expect(as("data_analyst", () => service.export("rpt-18", "pdf"))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
