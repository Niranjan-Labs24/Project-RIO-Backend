import { ForbiddenException, Injectable } from "@nestjs/common";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { getOrgStore } from "../../tenancy/org-context";
import { roleByKey } from "../../rbac/role-matrix";
import { EXPORTABLE_STATUSES } from "../reports/reports.types";
import type { SupervisorOverview, SupervisorOverviewRow } from "./supervisor-overview.types";

// Program Supervisor (center_supervisor) cross-organization, read-only
// overview. Deliberately its own module rather than reusing
// Organizations/Studies/Reports directly — those stay single-org-scoped for
// every other role, and this is the one screen that legitimately needs a
// cross-org join across all three, real data via the same cnap_supervisor
// SELECT-only path Sharing/Citizen already use (TenantPrismaService.
// runAsSupervisor), never a placeholder.
@Injectable()
export class SupervisorOverviewService {
  constructor(
    private readonly tenant: TenantPrismaService,
  ) {}

  async getOverview(): Promise<SupervisorOverview> {
    this.assertCrossEntity();

    const [organisations, studies, needs, reports, sharingRequests] = await Promise.all([
      this.tenant.runAsSupervisor((tx) => tx.organisation.findMany({ orderBy: { name: "asc" } })),
      this.tenant.runAsSupervisor((tx) => tx.study.findMany({ orderBy: { updatedAt: "desc" } })),
      this.tenant.runAsSupervisor((tx) => tx.need.findMany()),
      this.tenant.runAsSupervisor((tx) => tx.report.findMany({ where: { status: { in: EXPORTABLE_STATUSES } }, orderBy: { generatedAt: "desc" } })),
      this.tenant.runAsSupervisor((tx) => tx.sharingRequest.findMany({ orderBy: { requestedAt: "desc" } })),
    ]);

    // "In progress" means at least one Need under the Study hasn't reached
    // its terminal state (survey_published) yet — a Study is never itself
    // "done", only its Needs are. Precomputed once (O(needs)) rather than
    // rescanned per study/org below.
    const openStudyIds = new Set(
      needs.filter((n) => n.status !== "survey_published").map((n) => n.studyId),
    );

    // One pass each to build by-org lookup maps instead of rescanning the
    // full studies/reports/sharingRequests array per organisation.
    const activeStudyByOrg = new Map<string, (typeof studies)[number]>();
    const latestStudyByOrg = new Map<string, (typeof studies)[number]>();
    for (const study of studies) {
      if (!latestStudyByOrg.has(study.orgId)) latestStudyByOrg.set(study.orgId, study);
      if (openStudyIds.has(study.id) && !activeStudyByOrg.has(study.orgId)) activeStudyByOrg.set(study.orgId, study);
    }
    const latestReportByOrg = new Map<string, (typeof reports)[number]>();
    for (const report of reports) if (!latestReportByOrg.has(report.orgId)) latestReportByOrg.set(report.orgId, report);
    const sharingByOrg = new Map<string, (typeof sharingRequests)[number]>();
    for (const request of sharingRequests) {
      if (!sharingByOrg.has(request.ownerOrgId)) sharingByOrg.set(request.ownerOrgId, request);
      if (!sharingByOrg.has(request.requestingOrgId)) sharingByOrg.set(request.requestingOrgId, request);
    }

    const rows: SupervisorOverviewRow[] = organisations.map((org) => {
      const activeStudy = activeStudyByOrg.get(org.id);
      const latestReport = latestReportByOrg.get(org.id);
      const sharingRequest = sharingByOrg.get(org.id);
      const lastStudyActivity = latestStudyByOrg.get(org.id)?.updatedAt ?? org.updatedAt;

      return {
        organizationId: org.id,
        organizationName: org.name,
        activeStudyTitle: activeStudy?.title ?? null,
        latestReportTitle: latestReport?.title ?? null,
        sharingStatus: sharingRequest?.status ?? null,
        lastActivity: lastStudyActivity.toISOString(),
      };
    });

    return {
      totalOrganizations: organisations.length,
      studiesInProgress: studies.filter((s) => openStudyIds.has(s.id)).length,
      reportsShared: sharingRequests.filter((r) => r.status === "approved").length,
      pendingSharingRequests: sharingRequests.filter((r) => r.status === "pending").length,
      rows,
    };
  }

  private assertCrossEntity(): void {
    const role = getOrgStore()?.role;
    if (!role || roleByKey(role)?.crossEntity !== true) {
      throw new ForbiddenException({
        error: { code: "FORBIDDEN", message: "Only cross-entity roles can view the supervisor overview." },
      });
    }
  }
}
