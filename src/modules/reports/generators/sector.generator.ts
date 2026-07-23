import type { SectorReportContent } from "../report-content.types";
import type { GeneratedReport, GeneratorCtx } from "./index";

// RPT04 Sector / Domain-wise Needs. Aggregates severity by methodology domain.
// Same seam rule as village: the provider selects the same rows the Severity/
// Domain dashboard reads, so the report reconciles. Study-optional (org-wide
// when no studyId).
export async function sectorGenerator(ctx: GeneratorCtx): Promise<GeneratedReport> {
  const content: SectorReportContent = await ctx.provider.getSectorReport({
    studyId: ctx.studyId,
    studyTitle: ctx.studyTitle,
    orgId: ctx.orgId,
    filters: ctx.filters,
  });
  return {
    title: `Domain-wise Needs Report — ${content.header.studyName}`,
    content: content as unknown as Record<string, unknown>,
  };
}
