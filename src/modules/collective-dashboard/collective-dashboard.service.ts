import { Injectable } from "@nestjs/common";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireOrgId } from "../../tenancy/org-context";
import { ReportDataProvider } from "../reports/providers/report-data.provider";
import { ReviewerSlaService } from "../reviewer-sla/reviewer-sla.service";
import { slaComplianceFromAlerts } from "../reviewer-sla/sla-compliance";
import type { CollectiveDashboard } from "./collective-dashboard.types";

@Injectable()
export class CollectiveDashboardService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly provider: ReportDataProvider,
    private readonly sla: ReviewerSlaService,
  ) {}

  async get(filters: Record<string, unknown> = {}): Promise<CollectiveDashboard> {
    const orgId = requireOrgId();
    const [data, alerts, studyCount] = await Promise.all([
      // Real org-wide aggregate (priority rows + response-quality flags).
      this.provider.getCollectiveDashboard({ orgId, filters }),
      // Live SLA state from reviewer-sla.
      this.sla.listAlerts(),
      this.tenant.runInOrgContext((tx) => tx.study.count()),
    ]);

    // Shared with the RPT02 export so the screen and the PDF can't disagree.
    const { slaCompliancePct, breached, atRisk } = slaComplianceFromAlerts(alerts);

    return {
      scope: { studyCount, needCount: data.needCount, generatedAt: new Date().toISOString() },
      kpis: {
        needCount: data.needCount,
        scoringDistribution: data.scoringDistribution,
        slaCompliancePct,
        slaBreaches: breached,
        slaAtRisk: atRisk,
      },
      executiveSummary: {
        topPriorities: data.topPriorities,
        trends: data.trends,
        anomalies: data.anomalies,
        reviewerNotes: data.reviewerNotes,
      },
      filters,
    };
  }
}
