import type { TenantPrismaService } from "../../../tenancy/tenant-prisma.service";
import type { PortfolioBlock } from "../report-content.types";

// Organisation-level volume counts — the dashboard half of RPT15's "how big is
// the picture this survey sits inside?" band. Org-scoped by the tenant context
// (runInOrgContext / RLS), never cross-org: RPT15 is an NGO-role report, so a
// consolidated cross-entity view would be a different report entirely.
//
// Same batching rule as coverage-counts.ts — one Promise.all, no per-row loops.

/** groupBy rows → a stable, sorted {label, count} list the charts can render. */
function tally<T extends { _count: { _all: number } }>(
  rows: T[],
  key: (row: T) => string | null,
): Array<{ label: string; count: number }> {
  return rows
    .map((r) => ({ label: key(r) ?? "unknown", count: r._count._all }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export async function buildPortfolioBlock(
  tenant: TenantPrismaService,
  thisSurveyResponses: number,
): Promise<PortfolioBlock> {
  return tenant.runInOrgContext(async (tx) => {
    const [
      studiesTotal,
      needsTotal,
      needsByStatus,
      surveysTotal,
      surveysByStatus,
      publicLinksTotal,
      responsesTotal,
      evidenceFilesTotal,
      reportsTotal,
      reportsByStatus,
      sharingTotal,
      sharingByStatus,
      needs,
      governorates,
    ] = await Promise.all([
      tx.study.count(),
      tx.need.count(),
      tx.need.groupBy({ by: ["status"], _count: { _all: true } }),
      tx.survey.count(),
      tx.survey.groupBy({ by: ["status"], _count: { _all: true } }),
      tx.publicSurveyLink.count(),
      tx.surveyResponse.count(),
      tx.evidence.count(),
      tx.report.count(),
      tx.report.groupBy({ by: ["status"], _count: { _all: true } }),
      tx.reportSharingRequest.count(),
      tx.reportSharingRequest.groupBy({ by: ["status"], _count: { _all: true } }),
      // Villages have no master table (Need.village is a string[]), so the
      // distinct set has to be folded in memory — select only that column.
      tx.need.findMany({ select: { village: true } }),
      tx.needGovernorate.findMany({ select: { governorateId: true } }),
    ]);

    const villages = new Set(needs.flatMap((n) => n.village).filter(Boolean));

    return {
      studiesTotal,
      needsTotal,
      needsByStatus: tally(needsByStatus, (r) => r.status),
      surveysTotal,
      surveysByStatus: tally(surveysByStatus, (r) => r.status),
      publicLinksTotal,
      responsesTotal,
      evidenceFilesTotal,
      reportsTotal,
      reportsByStatus: tally(reportsByStatus, (r) => r.status),
      sharingRequestsTotal: sharingTotal,
      sharingRequestsByStatus: tally(sharingByStatus, (r) => r.status),
      villagesCovered: villages.size,
      governoratesCovered: new Set(governorates.map((g) => g.governorateId)).size,
      // How much of the org's total field data this one survey represents —
      // the number that tells a reader whether this survey is the whole picture
      // or a slice of it. 0 responses org-wide → 0, not a divide-by-zero NaN.
      thisSurveyShareOfResponsesPct:
        responsesTotal > 0 ? Math.round((thisSurveyResponses / responsesTotal) * 100) : 0,
    };
  });
}
