import { ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
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
    private readonly prisma: PrismaService,
  ) {}

  async getOverview(): Promise<SupervisorOverview> {
    this.assertCrossEntity();

    const [organisations, studies, needs, reports, sharingRequests] = await Promise.all([
      this.tenant.runAsSupervisor((tx) => tx.organisation.findMany({ orderBy: { name: "asc" } })),
      this.tenant.runAsSupervisor((tx) => tx.study.findMany({ orderBy: { updatedAt: "desc" } })),
      this.tenant.runAsSupervisor((tx) => tx.need.findMany()),
      this.tenant.runAsSupervisor((tx) => tx.report.findMany({ where: { status: { in: EXPORTABLE_STATUSES } }, orderBy: { generatedAt: "desc" } })),
      this.prisma.sharingRequest.findMany({ orderBy: { requestedAt: "desc" } }),
    ]);

    // "In progress" means at least one Need under the Study hasn't reached
    // its terminal state (survey_published) yet — a Study is never itself
    // "done", only its Needs are.
    const studyHasOpenNeed = (studyId: string): boolean =>
      needs.some((n) => n.studyId === studyId && n.status !== "survey_published");

    const rows: SupervisorOverviewRow[] = organisations.map((org) => {
      const activeStudy = studies.find((s) => s.orgId === org.id && studyHasOpenNeed(s.id));
      const latestReport = reports.find((r) => r.orgId === org.id);
      const sharingRequest = sharingRequests.find((r) => r.ownerOrgId === org.id || r.requestingOrgId === org.id);
      const lastStudyActivity = studies.find((s) => s.orgId === org.id)?.updatedAt ?? org.updatedAt;

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
      studiesInProgress: studies.filter((s) => studyHasOpenNeed(s.id)).length,
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
