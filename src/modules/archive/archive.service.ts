import { Injectable, NotFoundException } from "@nestjs/common";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { getOrgStore, requireOrgId } from "../../tenancy/org-context";
import { roleByKey } from "../../rbac/role-matrix";
import { AuditService } from "../audit/audit.service";
import { EXPORTABLE_STATUSES } from "../reports/reports.types";
import type { ArchiveEntry, ListArchiveParams } from "./archive.types";

// One filterable read view over Study + Report, not two parallel modules —
// Study Archive (completed studies) and the Report library (approved
// reports, which is what RPT-11 "Previous Studies View" also reads from)
// share the same filter dimensions. No new table: both underlying rows
// already exist, so this stays a read-only aggregation rather than a
// duplicated store.
//
// entity/region/sector/village are real filters, not placeholders:
// region/sector come from each entry's owning Organisation, village comes
// from the union of the Study's Needs (a Study can hold many Needs now).
// For a crossEntity role (system_admin, center_supervisor) this browses
// every organisation's archive, same cross-org SELECT-only path
// SupervisorOverviewService uses; for everyone else it stays scoped to the
// caller's own org exactly like before.
@Injectable()
export class ArchiveService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(params: ListArchiveParams): Promise<ArchiveEntry[]> {
    const isCrossEntity = this.isCrossEntity();

    const { organisations, studies, reports, needs } = await (isCrossEntity
      ? this.tenant.runAsSupervisor(async (tx) => ({
          organisations: await tx.organisation.findMany(),
          studies: await tx.study.findMany(),
          reports: await tx.report.findMany({ where: { status: { in: EXPORTABLE_STATUSES } } }),
          needs: await tx.need.findMany(),
        }))
      : this.tenant.runInOrgContext(async (tx) => ({
          organisations: await tx.organisation.findMany(),
          studies: await tx.study.findMany(),
          reports: await tx.report.findMany({ where: { status: { in: EXPORTABLE_STATUSES } } }),
          needs: await tx.need.findMany(),
        })));

    // Non-crossEntity callers only ever see their own org's rows anyway
    // (runInOrgContext is already RLS-scoped) — this just makes the org
    // filter a no-op default rather than a separate code path.
    const scopedOrgId = isCrossEntity ? null : requireOrgId();

    const orgById = new Map(organisations.map((org) => [org.id, org]));
    const studyById = new Map(studies.map((study) => [study.id, study]));
    const needsByStudyId = new Map<string, typeof needs>();
    for (const need of needs) {
      const list = needsByStudyId.get(need.studyId) ?? [];
      list.push(need);
      needsByStudyId.set(need.studyId, list);
    }
    const villagesByStudyId = new Map(
      [...needsByStudyId.entries()].map(([studyId, list]) => [studyId, [...new Set(list.flatMap((n) => n.village))]]),
    );
    // A Study is "completed" (archived) once every one of its Needs has
    // reached its terminal state — a Study with no Needs yet, or with any
    // Need still short of survey_published, isn't archive-eligible.
    const completedStudies = studies.filter((s) => {
      const studyNeeds = needsByStudyId.get(s.id) ?? [];
      return s.status === "archived" && studyNeeds.length > 0 && studyNeeds.every((n) => n.status === "survey_published");
    });

    const results: ArchiveEntry[] = [];
    if (!params.kind || params.kind === "study") {
      for (const study of completedStudies) {
        const org = orgById.get(study.orgId);
        results.push({
          id: study.id,
          kind: "study",
          title: study.title,
          status: "completed",
          date: study.updatedAt.toISOString(),
          studyId: study.id,
          organizationId: study.orgId,
          organizationName: org?.name ?? "",
          region: org?.region ?? [],
          // RIO-FR-013 (client Q26): "sector" here means the study's own
          // subject/domain, not the owning entity's sector — someone
          // filtering for "Health" wants health studies, not studies from
          // health-sector organisations.
          sector: study.targetSector ?? null,
          villages: villagesByStudyId.get(study.id) ?? [],
        });
      }
    }
    if (!params.kind || params.kind === "report") {
      for (const report of reports) {
        const org = orgById.get(report.orgId);
        const reportStudy = report.studyId ? studyById.get(report.studyId) : undefined;
        results.push({
          id: report.id,
          kind: "report",
          title: report.title,
          status: report.status,
          date: (report.reviewedAt ?? report.generatedAt).toISOString(),
          studyId: report.studyId,
          organizationId: report.orgId,
          organizationName: org?.name ?? "",
          region: org?.region ?? [],
          // Same subject-based sector as the study branch above (RIO-FR-013, Q26).
          sector: reportStudy?.targetSector ?? null,
          villages: report.studyId ? (villagesByStudyId.get(report.studyId) ?? []) : [],
        });
      }
    }

    return results
      .filter((entry) => (scopedOrgId ? entry.organizationId === scopedOrgId : true))
      .filter((entry) => (params.organizationId ? entry.organizationId === params.organizationId : true))
      .filter((entry) => (params.search ? entry.title.toLowerCase().includes(params.search.toLowerCase()) : true))
      .filter((entry) => (params.region ? entry.region.includes(params.region) : true))
      .filter((entry) => (params.sector ? entry.sector === params.sector : true))
      .filter((entry) => (params.village ? entry.villages.includes(params.village) : true))
      .filter((entry) => (params.dateFrom ? entry.date >= params.dateFrom : true))
      .filter((entry) => (params.dateTo ? entry.date <= params.dateTo : true))
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  private isCrossEntity(): boolean {
    const role = getOrgStore()?.role;
    return role !== undefined && roleByKey(role)?.crossEntity === true;
  }

  async getArchiveDetail(studyId: string) {
    const isCrossEntity = this.isCrossEntity();
    const include = {
      org: true,
      methodologyVersion: true,
      needs: true,
      reports: true,
      evidence: true,
    };

    const study = await (isCrossEntity
      ? this.tenant.runAsSupervisor((tx) => tx.study.findUnique({ where: { id: studyId }, include }))
      : this.tenant.runInOrgContext((tx) => tx.study.findUnique({ where: { id: studyId }, include })));

    if (!study) {
      throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Archived study not found' } });
    }

    const auditLogs = await (isCrossEntity
      ? this.tenant.runAsSupervisor((tx) =>
          tx.auditLog.findMany({
            where: { entityType: 'study', entityId: studyId },
            orderBy: { createdAt: 'desc' },
            take: 20,
          }),
        )
      : this.tenant.runInOrgContext((tx) =>
          tx.auditLog.findMany({
            where: { entityType: 'study', entityId: studyId },
            orderBy: { createdAt: 'desc' },
            take: 20,
          }),
        ));

    if (isCrossEntity) {
      await this.audit.record({
        action: 'SYSTEM_ADMIN_VIEWED_ARCHIVED_REPORT',
        entityType: 'study',
        entityId: studyId,
        entityLabel: study.title,
        organizationId: study.orgId,
      });
    }

    return {
      id: study.id,
      title: study.title,
      status: study.status,
      cycleNumber: study.cycleNumber,
      organizationId: study.orgId,
      organizationName: study.org?.name ?? '',
      region: study.org?.region ?? [],
      // RIO-FR-013 (client Q26): study's own subject, not the owning entity's sector.
      sector: study.targetSector ?? null,
      villages: study.villages,
      createdAt: study.createdAt.toISOString(),
      updatedAt: study.updatedAt.toISOString(),
      archivedAt: study.archivedAt ? study.archivedAt.toISOString() : null,
      archivedBy: study.archivedBy,
      archiveReason: study.archiveReason,
      methodologyVersion: study.methodologyVersion
        ? { id: study.methodologyVersion.id, version: study.methodologyVersion.version, name: study.methodologyVersion.name }
        : null,
      evidenceCount: study.evidence?.length ?? 0,
      needsCount: study.needs?.length ?? 0,
      reports:
        study.reports?.map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          reportType: r.reportType,
          generatedAt: r.generatedAt.toISOString(),
        })) ?? [],
      auditHistory: auditLogs.map((log) => ({
        id: log.id,
        action: log.action,
        actorUserId: log.actorUserId,
        createdAt: log.createdAt.toISOString(),
        metadata: log.metadata,
      })),
    };
  }
}
