import { Injectable } from "@nestjs/common";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireOrgId } from "../../tenancy/org-context";
import { ReportDataProvider } from "../reports/providers/report-data.provider";
import { ReviewerSlaService } from "../reviewer-sla/reviewer-sla.service";
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
      // Aggregated analytics + executive summary (mock now → real on swap).
      this.provider.getCollectiveDashboard({ orgId, filters }),
      // Live SLA state from reviewer-sla.
      this.sla.listAlerts(),
      this.tenant.runInOrgContext((tx) => tx.study.count()),
    ]);

    const breached = alerts.filter((a) => a.status === "breached").length;
    const atRisk = alerts.filter((a) => a.status === "at_risk").length;
    const total = alerts.length;
    // Approximate compliance from the open reviewer-SLA queue: the share not
    // breached. TODO(reviewer-sla): replace with a completed-within-SLA metric
    // over a reporting period once ReviewerSlaService exposes one.
    const slaCompliancePct = total === 0 ? null : Math.round(((total - breached) / total) * 100);

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
