import type { RegionReportContent } from "../report-content.types";
import type { GeneratedReport, GeneratorCtx } from "./index";

// RPT06 Region/Governorate report. Per-region aggregation of approved priority
// scores over KSA geography. Reconciles with the Priority dashboard filtered by
// region. Study-optional (org-wide when no studyId).
export async function regionGenerator(ctx: GeneratorCtx): Promise<GeneratedReport> {
  const content: RegionReportContent = await ctx.provider.getRegionReport({
    studyId: ctx.studyId,
    studyTitle: ctx.studyTitle,
    orgId: ctx.orgId,
    filters: ctx.filters,
  });
  return {
    title: `Regional Needs Report — ${content.header.studyName}`,
    content: content as unknown as Record<string, unknown>,
  };
}
