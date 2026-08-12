import type { TenantPrismaService } from "../../../tenancy/tenant-prisma.service";
import { normalizeDomainKey } from "../../priority/priority-v2.service";
import type { ClassificationRow } from "./build-need-records";
import type { MethodologyDomain } from "./compose-executive-summary";

// The reference data RPT01 needs beyond the scoring snapshot: the methodology
// hierarchy every KPI hangs from, the full domain list (including the domains
// this survey did NOT touch), the domain weights, this survey's question counts,
// and the answer-status breakdown behind the exclusions.
//
// Read once per report, in one org-scoped transaction (RIO-NFR-005) — never a
// per-entity loop.

export interface Rpt01ReferenceData {
  /** Keyed by the KPI rollup's entityId, which is the KPI name. */
  classificationByIndicator: Map<string, ClassificationRow>;
  /** EVERY methodology domain, so uncovered ones can be listed as uncovered. */
  allDomains: MethodologyDomain[];
  /** Methodology KPIs defined per domain key. */
  kpisDefinedByDomainKey: Map<string, number>;
  domainWeightByKey: Map<string, number | null>;
  criticalDomainKeys: Set<string>;
  /** Questions THIS survey asked, per domain key. */
  questionsAskedByDomainKey: Map<string, number>;
  /** ResponseSeverityScore.scoreStatus tallies — what "excluded" actually was. */
  exclusionBreakdown: Array<{ status: string; count: number }>;
  totalAnswers: number;
}

export async function loadRpt01ReferenceData(
  tenant: TenantPrismaService,
  query: { studyId: string; surveyId: string; methodologyVersionId: string; villageId?: string },
): Promise<Rpt01ReferenceData> {
  const { studyId, surveyId, methodologyVersionId } = query;

  return tenant.runInOrgContext(async (tx) => {
    const [questions, weights, surveyQuestions, answerStatuses] = await Promise.all([
      // Same selector the scoring pipeline uses, now version-scoped
      // (RIO-AI-005): `methodology_version_id` is NOT NULL as of
      // 20260812090000, so the old "bank questions may carry a null version"
      // caveat no longer holds, and an unscoped read would mix a retired
      // version's hierarchy into the one that actually produced these rollups.
      tx.question.findMany({
        where: { methodologyVersionId, usedInMvp: true },
        select: { id: true, questionId: true, domain: true, subDomain: true, indicator: true, kpi: true },
      }),
      tx.domainPriorityConfig.findMany({ where: { methodologyVersionId } }),
      // `questionId` here is the Question ROW id (uuid), not the bank's
      // `questionId` code. Joining on the code matched nothing and reported
      // zero questions for every domain; `domain` covers custom questions,
      // which have no bank row at all.
      tx.surveyQuestion.findMany({ where: { surveyId }, select: { questionId: true, domain: true } }),
      tx.responseSeverityScore.groupBy({
        by: ["scoreStatus"],
        where: { studyId, surveyId, methodologyVersionId },
        _count: true,
      }),
    ]);

    const classificationByIndicator = new Map<string, ClassificationRow>();
    const subDomainsByDomainKey = new Map<string, Set<string>>();
    const kpisByDomainKey = new Map<string, Set<string>>();
    const domainNameByKey = new Map<string, string>();
    const domainKeyByQuestionId = new Map<string, string>();

    for (const q of questions) {
      const domainKey = normalizeDomainKey(q.domain);
      domainNameByKey.set(domainKey, q.domain);
      domainKeyByQuestionId.set(q.id, domainKey);

      const subs = subDomainsByDomainKey.get(domainKey) ?? new Set<string>();
      subs.add(q.subDomain);
      subDomainsByDomainKey.set(domainKey, subs);

      if (!q.kpi) continue;
      const kpis = kpisByDomainKey.get(domainKey) ?? new Set<string>();
      kpis.add(q.kpi);
      kpisByDomainKey.set(domainKey, kpis);

      // KPI rollups key on the KPI name (RollupService writes entityId = the KPI
      // name), so that is the join key. First definition wins — a KPI belongs to
      // exactly one indicator in the bank.
      if (!classificationByIndicator.has(q.kpi)) {
        classificationByIndicator.set(q.kpi, {
          domain: q.domain,
          domainKey,
          subDomain: q.subDomain,
          subDomainKey: normalizeDomainKey(q.subDomain),
          // The bank has no stable indicator code column yet, so the indicator
          // name is its id. A dedicated `indicatorId` is a bank migration, and
          // this stays the join key until it lands.
          indicatorId: q.indicator ?? q.kpi,
          indicatorName: q.indicator ?? q.kpi,
          // No per-KPI gap_type override exists in the bank yet; every survey
          // gap type is therefore derived from the thresholds.
          gapTypeHint: null,
        });
      }
    }

    const questionsAskedByDomainKey = new Map<string, number>();
    for (const sq of surveyQuestions) {
      const key = sq.questionId
        ? domainKeyByQuestionId.get(sq.questionId)
        : sq.domain
          ? normalizeDomainKey(sq.domain)
          : undefined;
      if (!key) continue;
      questionsAskedByDomainKey.set(key, (questionsAskedByDomainKey.get(key) ?? 0) + 1);
    }

    const allDomains: MethodologyDomain[] = [...domainNameByKey.entries()]
      .map(([domainKey, domain]) => ({
        domain,
        domainKey,
        subDomainCount: subDomainsByDomainKey.get(domainKey)?.size ?? 0,
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain));

    const exclusionBreakdown = answerStatuses
      .map((a) => ({ status: a.scoreStatus, count: a._count }))
      .sort((a, b) => b.count - a.count);

    return {
      classificationByIndicator,
      allDomains,
      kpisDefinedByDomainKey: new Map(
        [...kpisByDomainKey.entries()].map(([k, v]) => [k, v.size]),
      ),
      domainWeightByKey: new Map(weights.map((w) => [w.domainKey, Number(w.weight)])),
      criticalDomainKeys: new Set(weights.filter((w) => w.isCriticalDomain).map((w) => w.domainKey)),
      questionsAskedByDomainKey,
      exclusionBreakdown,
      totalAnswers: exclusionBreakdown.reduce((n, e) => n + e.count, 0),
    };
  });
}
