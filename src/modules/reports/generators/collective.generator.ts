import type { CollectiveReportContent } from "../report-content.types";
import type { GeneratedReport, GeneratorCtx } from "./index";

// RPT02 Collective Report / Dashboard. Cross-study/entity KPIs (needs count,
// scoring distribution, SLA compliance) + an executive-summary narrative.
// Org-wide (no studyId). Reads through the provider seam.
export async function collectiveGenerator(ctx: GeneratorCtx): Promise<GeneratedReport> {
  const content: CollectiveReportContent = await ctx.provider.getCollectiveReport({
    studyId: ctx.studyId,
    studyTitle: ctx.studyTitle,
    orgId: ctx.orgId,
    filters: ctx.filters,
  });
  return {
    title: `Collective Report — ${content.header.studyName}`,
    content: content as unknown as Record<string, unknown>,
  };
}
