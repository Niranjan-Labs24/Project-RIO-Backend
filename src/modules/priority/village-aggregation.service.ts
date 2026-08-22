import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore } from '../../tenancy/org-context';
import type { PriorityScoreRow, VillageComparisonEntry } from './priority.types';

// RIO-FR-005 (Q9) — cross-entity comparison scope, same convention as
// StudiesService's isSysAdmin branch: system_admin and center_supervisor
// (the confirmed "NCNP" role) read across every org via the supervisor
// client; every other role stays inside their own org's RLS-scoped data.
const CROSS_ENTITY_COMPARISON_ROLES = new Set(['system_admin', 'center_supervisor']);

// Extracted out of PriorityService (2026-08-22) — RIO-FR-005's own village
// comparison and RIO-FR-008's Sprint 3 interactive map are both, at bottom,
// "aggregate this org's/these orgs' Needs and VillagePriorityAssessments by
// village" — the exact same underlying computation, just rendered two
// different ways (a comparison table here, map markers there). Pulled into
// its own service now, ahead of FR-008 actually starting, specifically so
// FR-008 can inject and call `aggregateByVillage` directly instead of a
// second implementation growing next to this one — no behavior change from
// the version this replaced (PriorityService.compareVillages).
@Injectable()
export class VillageAggregationService {
  constructor(private readonly tenant: TenantPrismaService) {}

  async compareVillages(studyIds: string[]): Promise<VillageComparisonEntry[]> {
    const byVillage = await this.aggregateByVillage(studyIds);
    return Array.from(byVillage.values()).sort((a, b) => a.village.localeCompare(b.village));
  }

  // The shared aggregation step, returned keyed by village name rather than
  // as the final sorted array — FR-008's map only needs to iterate markers,
  // not present an ordered list, and a Map lets it look up one village's
  // aggregate directly (e.g. on marker click) without a linear scan.
  async aggregateByVillage(studyIds: string[]): Promise<Map<string, VillageComparisonEntry>> {
    if (studyIds.length === 0) {
      throw new BadRequestException({
        error: { code: 'NO_STUDIES_SELECTED', message: 'Select at least one study to compare.' },
      });
    }
    const store = getOrgStore();
    const crossEntity = store?.role ? CROSS_ENTITY_COMPARISON_ROLES.has(store.role) : false;
    const runner = crossEntity
      ? this.tenant.runAsSupervisor.bind(this.tenant)
      : this.tenant.runInOrgContext.bind(this.tenant);

    const { needs, scores, assessments } = await runner(async (tx) => {
      const studies = await tx.study.findMany({ where: { id: { in: studyIds } }, select: { id: true } });
      const foundIds = new Set(studies.map((s) => s.id));
      const missing = studyIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new NotFoundException({
          error: { code: 'STUDY_NOT_FOUND', message: `Study not found or not accessible: ${missing.join(', ')}` },
        });
      }
      const needs = await tx.need.findMany({ where: { studyId: { in: studyIds } } });
      const scores = await tx.priorityScore.findMany({
        where: { studyId: { in: studyIds }, surveyLinkId: null, approvedAt: { not: null } },
        orderBy: { scoredAt: 'desc' },
      });
      const assessments = await tx.villagePriorityAssessment.findMany({
        where: { studyId: { in: studyIds } },
        orderBy: { calculatedAt: 'desc' },
      });
      return { needs, scores, assessments };
    });

    const latestScoreByNeed = new Map<string, PriorityScoreRow>();
    for (const row of scores as unknown as PriorityScoreRow[]) {
      if (!latestScoreByNeed.has(row.needId)) latestScoreByNeed.set(row.needId, row);
    }

    // Latest assessment per village across the selected studies — a
    // village can have more than one row (different studies/surveys); the
    // most recently calculated one is what a comparison/map should show.
    const latestAssessmentByVillage = new Map<string, (typeof assessments)[number]>();
    for (const a of assessments) {
      if (!latestAssessmentByVillage.has(a.villageId)) latestAssessmentByVillage.set(a.villageId, a);
    }

    const byVillage = new Map<string, VillageComparisonEntry>();
    for (const need of needs) {
      const villages = need.village.length > 0 ? need.village : ['(unassigned)'];
      const scoreRow = latestScoreByNeed.get(need.id);
      const domainKey = need.domain ?? '(unclassified)';
      for (const village of villages) {
        let entry = byVillage.get(village);
        if (!entry) {
          const assessment = latestAssessmentByVillage.get(village);
          entry = {
            village,
            studyIds: [],
            priorityScore: assessment ? Number(assessment.priorityScore) : null,
            priorityStatus: assessment?.priorityStatus ?? null,
            domainComponents: assessment?.domainComponents ?? null,
            criticalNeedCount: 0,
            highNeedCount: 0,
            needTypeCounts: {},
            totalNeedCount: 0,
          };
          byVillage.set(village, entry);
        }
        if (!entry.studyIds.includes(need.studyId)) entry.studyIds.push(need.studyId);
        entry.totalNeedCount += 1;
        entry.needTypeCounts[domainKey] = (entry.needTypeCounts[domainKey] ?? 0) + 1;
        if (scoreRow?.level === 'critical') entry.criticalNeedCount += 1;
        else if (scoreRow?.level === 'high') entry.highNeedCount += 1;
      }
    }

    return byVillage;
  }
}
