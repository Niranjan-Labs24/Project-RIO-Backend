import { Injectable } from "@nestjs/common";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { getOrgStore, requireOrgId } from "../../tenancy/org-context";
import { roleByKey } from "../../rbac/role-matrix";
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
  constructor(private readonly tenant: TenantPrismaService) {}

  async list(params: ListArchiveParams): Promise<ArchiveEntry[]> {
    const isCrossEntity = this.isCrossEntity();

    const { organisations, studies, reports, needs } = await (isCrossEntity
      ? this.tenant.runAsSupervisor(async (tx) => ({
          organisations: await tx.organisation.findMany(),
          studies: await tx.study.findMany(),
          reports: await tx.report.findMany({ where: { status: "approved" } }),
          needs: await tx.need.findMany(),
        }))
      : this.tenant.runInOrgContext(async (tx) => ({
          organisations: await tx.organisation.findMany(),
          studies: await tx.study.findMany(),
          reports: await tx.report.findMany({ where: { status: "approved" } }),
          needs: await tx.need.findMany(),
        })));

    // Non-crossEntity callers only ever see their own org's rows anyway
    // (runInOrgContext is already RLS-scoped) — this just makes the org
    // filter a no-op default rather than a separate code path.
    const scopedOrgId = isCrossEntity ? null : requireOrgId();

    const orgById = new Map(organisations.map((org) => [org.id, org]));
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
      return studyNeeds.length > 0 && studyNeeds.every((n) => n.status === "survey_published");
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
          sector: org?.sector ?? null,
          villages: villagesByStudyId.get(study.id) ?? [],
        });
      }
    }
    if (!params.kind || params.kind === "report") {
      for (const report of reports) {
        const org = orgById.get(report.orgId);
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
          sector: org?.sector ?? null,
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
}
