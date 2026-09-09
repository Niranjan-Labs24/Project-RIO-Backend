import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ReportsModule } from "../reports.module";
import { ReportDataProvider } from "./report-data.provider";
import { ReportSummaryDataProvider } from "./report-summary-data.provider";
import { StubReportDataProvider } from "./__fixtures__/report-content.fixtures";

// Attestation, not a behaviour test (RIO-RPT-001 / the "these reports are
// real" review): every core report reads through the ReportDataProvider seam,
// so which class sits behind that seam at runtime decides whether a released,
// approved, exported report carries real analytics or fixture data — and
// nothing in the exported document says which it was. That question used to
// be answerable only by reading reports.module.ts, so this pins it.
//
// The fixture provider is deliberately still in the tree; specs need it. This
// asserts it never becomes the bound one, which is the failure that matters.
describe("ReportDataProvider binding", () => {
  const providers = (Reflect.getMetadata("providers", ReportsModule) ?? []) as Array<
    { provide?: unknown; useClass?: unknown } | unknown
  >;

  const binding = providers.find(
    (p): p is { provide: unknown; useClass: unknown } =>
      typeof p === "object" && p !== null && "provide" in p && p.provide === ReportDataProvider,
  );

  it("is bound in ReportsModule", () => {
    expect(binding).toBeDefined();
  });

  it("resolves to the real provider, never the spec fixture", () => {
    expect(binding?.useClass).toBe(ReportSummaryDataProvider);
    expect(binding?.useClass).not.toBe(StubReportDataProvider);
  });

  // The real provider's own contract: a study with no scored data raises
  // STUDY_NOT_SCORED so the caller can act on it, and an infrastructure fault
  // propagates. Neither is answered with fixtures — that behaviour is what
  // makes the binding above sufficient evidence rather than just necessary.
  it("does not extend or delegate to the fixture provider", () => {
    expect(Object.getPrototypeOf(ReportSummaryDataProvider)).toBe(ReportDataProvider);
    expect(ReportSummaryDataProvider.prototype).not.toBeInstanceOf(StubReportDataProvider);
  });
});
