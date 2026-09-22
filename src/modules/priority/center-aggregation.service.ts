import { EXCLUDE_MERGED } from '../needs/need-visibility';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore } from '../../tenancy/org-context';
import { DEFAULT_THRESHOLDS, mapPriorityLevel, type ScoringThresholds } from './scoring';
import type { CenterComparisonEntry, KpiSeverityEntry, PriorityScoreRow } from './priority.types';

// RIO-FR-005 (Q9) — cross-entity comparison scope, same convention as
// StudiesService's isCrossOrgReader branch: system_admin, system_reviewer
// (also platform-wide, no tenant org of its own), and center_supervisor (the
// confirmed "NCNP" role) read across every org via the supervisor client;
// every other role stays inside their own org's RLS-scoped data.
const CROSS_ENTITY_COMPARISON_ROLES = new Set(['system_admin', 'system_reviewer', 'center_supervisor']);

/**
 * RIO-FR-005 — comparing places against each other, and the aggregate
 * RIO-FR-008's map plots.
 *
 * ─── Why Center, not village ────────────────────────────────────────────────
 * `Need.village` is free text a researcher types. Nothing validates it, the
 * same place is spelled several ways, and the client confirmed (Sprint 3
 * clarifications Q2) that no authoritative village dataset exists on their
 * side or in any open source. Grouping on that string groups on a typo as
 * readily as on a place.
 *
 * Center is the smallest unit the platform actually has authoritative data
 * for: 1,404 of them in the client's own KSA Geographic Reference, each with
 * a stable code, a parent governorate and region, and geocoded coordinates.
 * A Need is linked to its Center through NeedCenter — a real foreign key, not
 * a string. So the comparison groups on Center and reports the village names
 * underneath as labels, which is what they honestly are.
 *
 * ─── Why the average of Priority Scores ─────────────────────────────────────
 * This used to read VillagePriorityAssessment — a second, separate score with
 * its own domain weights AND the opposite polarity (there, low meant urgent).
 * Two scores for one question caused a real bug: the Priority Dashboard read
 * the wrong one and showed "Not scored yet" for needs that were fully scored.
 *
 * There is one priority number in this platform, the per-Need PriorityScore
 * that FR-003 defines and a reviewer signs off. A place's score is the mean
 * of its needs' scores. Same 0-100 scale, same direction (high = urgent),
 * same bands from the same configured thresholds — so a centre reading 85
 * and a need reading 85 mean the same thing.
 *
 * That also removes this path's dependency on DomainPriorityConfig, which is
 * only seeded for a retired methodology version, so every study created
 * against the live one produced no assessment at all.
 */
@Injectable()
export class CenterAggregationService {
  constructor(private readonly tenant: TenantPrismaService) {}

  async compareCenters(studyIds: string[]): Promise<CenterComparisonEntry[]> {
    const byCenter = await this.aggregateByCenter(studyIds);
    return Array.from(byCenter.values()).sort((a, b) =>
      a.centerName.localeCompare(b.centerName),
    );
  }

  /**
   * The shared aggregation step, keyed by centre id rather than returned as a
   * sorted array — FR-008's map looks one centre's aggregate up directly on
   * marker click rather than scanning a list.
   */
  async aggregateByCenter(studyIds: string[]): Promise<Map<string, CenterComparisonEntry>> {
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

    const { needs, scores, centers, thresholds } = await runner(async (tx) => {
      const studies = await tx.study.findMany({
        where: { id: { in: studyIds } },
        select: { id: true },
      });
      const foundIds = new Set(studies.map((s) => s.id));
      const missing = studyIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new NotFoundException({
          error: {
            code: 'STUDY_NOT_FOUND',
            message: `Study not found or not accessible: ${missing.join(', ')}`,
          },
        });
      }

      const needs = await tx.need.findMany({
        where: { studyId: { in: studyIds }, ...EXCLUDE_MERGED },
        include: { needCenters: { select: { centerId: true } } },
      });

      // Approved scores only: an unapproved number has not cleared the
      // FR-003 human-review gate, and averaging it into a place's headline
      // figure would publish it through the back door.
      const scores = await tx.priorityScore.findMany({
        where: {
          studyId: { in: studyIds },
          surveyLinkId: null,
          approvedAt: { not: null },
        },
        orderBy: { scoredAt: 'desc' },
      });

      const centerIds = [...new Set(needs.flatMap((n) => n.needCenters.map((c) => c.centerId)))];
      const centers = centerIds.length
        ? await tx.center.findMany({
            where: { id: { in: centerIds } },
            select: {
              id: true,
              name: true,
              nameAr: true,
              governorate: {
                select: { name: true, nameAr: true, region: { select: { name: true, nameAr: true } } },
              },
            },
          })
        : [];

      const config = await tx.methodologyConfig.findFirst();
      const raw = (config?.priorityThresholds ?? {}) as Partial<ScoringThresholds>;
      const thresholds: ScoringThresholds = {
        criticalSeverity: raw.criticalSeverity ?? DEFAULT_THRESHOLDS.criticalSeverity,
        highSeverity: raw.highSeverity ?? DEFAULT_THRESHOLDS.highSeverity,
        equityHighSeverity: raw.equityHighSeverity ?? DEFAULT_THRESHOLDS.equityHighSeverity,
        mediumSeverity: raw.mediumSeverity ?? DEFAULT_THRESHOLDS.mediumSeverity,
      };

      return { needs, scores, centers, thresholds };
    });

    const latestScoreByNeed = new Map<string, PriorityScoreRow>();
    for (const row of scores as unknown as PriorityScoreRow[]) {
      if (!latestScoreByNeed.has(row.needId)) latestScoreByNeed.set(row.needId, row);
    }
    const centerById = new Map(centers.map((c) => [c.id, c]));

    // Running totals per centre, and per domain within it. Kept alongside the
    // entry rather than on it so the public shape carries only averages.
    const totals = new Map<string, { sum: number; count: number }>();
    // Per-domain running totals also carry critical/high counts among the
    // Needs actually contributing to that domain's mean — the platform-level
    // equivalent of Annex A's Station 6 "no-masking rule" (BRD, "any
    // indicator crossing the critical threshold surfaces and escalates
    // automatically, regardless of its domain average"). The workbook
    // enforces this at KPI/indicator granularity; this platform scores at
    // Need granularity instead (see this file's own header comment on why),
    // so the equivalent guarantee here is: a domain's own average tier must
    // never be the only visible signal when one of its Needs is
    // individually Critical or High.
    const domainTotals = new Map<
      string,
      Map<string, { sum: number; count: number; criticalCount: number; highCount: number }>
    >();

    const byCenter = new Map<string, CenterComparisonEntry>();

    for (const need of needs) {
      const scoreRow = latestScoreByNeed.get(need.id);
      // The reviewer's override is the number this need is ranked on, so it
      // is the number that feeds the place's mean too.
      const effective = scoreRow ? (scoreRow.overrideScore ?? scoreRow.overallScore) : null;
      const domainKey = need.domain ?? '(unclassified)';

      // A Need with no Center cannot be placed. Reported under a single
      // bucket rather than dropped, so the totals still add up to the study's
      // real need count — the same rule FR-008's map uses for unmapped needs.
      const linked = need.needCenters.length > 0 ? need.needCenters.map((c) => c.centerId) : [UNPLACED];

      for (const centerId of linked) {
        let entry = byCenter.get(centerId);
        if (!entry) {
          const center = centerById.get(centerId);
          entry = {
            centerId,
            centerName: center?.name ?? UNPLACED_LABEL,
            centerNameAr: center?.nameAr ?? null,
            governorateName: center?.governorate.name ?? null,
            governorateNameAr: center?.governorate.nameAr ?? null,
            regionName: center?.governorate.region?.name ?? null,
            regionNameAr: center?.governorate.region?.nameAr ?? null,
            villages: [],
            studyIds: [],
            priorityScore: null,
            priorityStatus: null,
            scoredNeedCount: 0,
            domainBreakdown: [],
            criticalNeedCount: 0,
            highNeedCount: 0,
            needTypeCounts: {},
            totalNeedCount: 0,
            affectedPeople: null,
            affectedHouseholds: null,
          };
          byCenter.set(centerId, entry);
          totals.set(centerId, { sum: 0, count: 0 });
          domainTotals.set(centerId, new Map());
        }

        if (!entry.studyIds.includes(need.studyId)) entry.studyIds.push(need.studyId);
        // Village names are labels here, not keys — see the class comment.
        for (const v of need.village) if (v && !entry.villages.includes(v)) entry.villages.push(v);

        entry.totalNeedCount += 1;
        entry.needTypeCounts[domainKey] = (entry.needTypeCounts[domainKey] ?? 0) + 1;

        if (effective !== null) {
          const t = totals.get(centerId)!;
          t.sum += effective;
          t.count += 1;
          entry.scoredNeedCount += 1;

          const perDomain = domainTotals.get(centerId)!;
          const d = perDomain.get(domainKey) ?? { sum: 0, count: 0, criticalCount: 0, highCount: 0 };
          d.sum += effective;
          d.count += 1;

          const level = mapPriorityLevel(effective, false, thresholds);
          if (level === 'critical') {
            entry.criticalNeedCount += 1;
            d.criticalCount += 1;
          } else if (level === 'high') {
            entry.highNeedCount += 1;
            d.highCount += 1;
          }
          perDomain.set(domainKey, d);
        }

        // RIO-FR-005 (Round 4, client-confirmed 2026-08-24) — sum only the
        // Needs that actually have a manually entered value; stays null (not
        // 0) until at least one does, so the UI can tell "no data yet" apart
        // from "confirmed zero".
        if (need.affectedPeople !== null) {
          entry.affectedPeople = (entry.affectedPeople ?? 0) + need.affectedPeople;
        }
        if (need.affectedHouseholds !== null) {
          entry.affectedHouseholds = (entry.affectedHouseholds ?? 0) + need.affectedHouseholds;
        }
      }
    }

    for (const [centerId, entry] of byCenter) {
      const t = totals.get(centerId)!;
      if (t.count > 0) {
        const mean = t.sum / t.count;
        entry.priorityScore = Math.round(mean * 10) / 10;
        entry.priorityStatus = mapPriorityLevel(mean, false, thresholds);
      }
      const perDomain = domainTotals.get(centerId)!;
      entry.domainBreakdown = [...perDomain.entries()]
        .map(([domain, d]) => {
          const mean = d.sum / d.count;
          const level = mapPriorityLevel(mean, false, thresholds);
          return {
            domain,
            needCount: d.count,
            averageScore: Math.round(mean * 10) / 10,
            level,
            criticalNeedCount: d.criticalCount,
            highNeedCount: d.highCount,
            // No-masking flag (BRD Annex A, Station 6a): true when this
            // domain's own averaged tier reads calmer than Critical, yet at
            // least one Need feeding that average is individually Critical —
            // the exact "average hides an outlier" failure Annex A calls out
            // by name. Never true for a domain whose average already IS
            // Critical: nothing is being hidden if the headline already
            // shows the worst case.
            maskedCritical: level !== 'critical' && d.criticalCount > 0,
          };
        })
        // Worst first — that is the order a reviewer scanning a place reads in.
        .sort((a, b) => b.averageScore - a.averageScore);
      entry.villages.sort((a, b) => a.localeCompare(b));
    }

    return byCenter;
  }

  /**
   * RIO-FR-005 — heat map side panel, per Jagan's clarification mail
   * (2026-09-21): clicking a domain × village cell lists every KPI scored
   * under that domain for that centre, not just the domain's own average.
   *
   * Severity/Confidence/KPI-name come from `ScoreRollup` (rollupLevel='KPI'),
   * one row per Need's own published survey — this platform has no single
   * village-wide KPI rollup, only per-survey ones, so each contributing
   * Need's survey is read individually and the rows concatenated. Analytical
   * Category is joined from the Question Bank via the rollup's `entityId`,
   * which for a KPI-level rollup is that KPI's own anchor question code (see
   * Question.feedsKpiAnchor). Gap Type and Equity Flag are NOT scored per
   * KPI anywhere in this platform — both are analyst/engine outputs at Need
   * granularity (Need.gapType is analyst-entered on the View Metrics screen;
   * equityFlagged is PriorityService.score()'s persisted equity-spread
   * result) — so every KPI under a given Need inherits that Need's own
   * values, which is the only source either field has.
   */
  async kpiBreakdownForDomain(
    centerId: string,
    domain: string,
    studyIds: string[],
  ): Promise<KpiSeverityEntry[]> {
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

    return runner(async (tx) => {
      const needs = await tx.need.findMany({
        where: {
          studyId: { in: studyIds },
          domain,
          ...EXCLUDE_MERGED,
          needCenters: { some: { centerId } },
        },
      });
      if (needs.length === 0) return [];

      const needIds = needs.map((n) => n.id);
      const scores = await tx.priorityScore.findMany({
        where: { needId: { in: needIds }, surveyLinkId: null, approvedAt: { not: null } },
        orderBy: { scoredAt: 'desc' },
      });
      const latestScoreByNeed = new Map<string, (typeof scores)[number]>();
      for (const row of scores) if (!latestScoreByNeed.has(row.needId)) latestScoreByNeed.set(row.needId, row);

      const surveys = await tx.survey.findMany({
        where: { needId: { in: needIds }, status: 'PUBLISHED' },
      });
      const surveyByNeed = new Map(surveys.map((s) => [s.needId, s]));

      const config = await tx.methodologyConfig.findFirst();
      const raw = (config?.priorityThresholds ?? {}) as Partial<ScoringThresholds>;
      const thresholds: ScoringThresholds = {
        criticalSeverity: raw.criticalSeverity ?? DEFAULT_THRESHOLDS.criticalSeverity,
        highSeverity: raw.highSeverity ?? DEFAULT_THRESHOLDS.highSeverity,
        equityHighSeverity: raw.equityHighSeverity ?? DEFAULT_THRESHOLDS.equityHighSeverity,
        mediumSeverity: raw.mediumSeverity ?? DEFAULT_THRESHOLDS.mediumSeverity,
      };

      // Resolved here, server-side, rather than making the frontend call
      // GET /study-config/gap-types itself: that endpoint is gated on
      // methodologyQuestionBank:read, which most roles viewing this screen
      // don't hold (ngo_admin, client-confirmed 2026-08-20 — same reason
      // useDomainArabicMap reads the public Domain tree instead of the
      // gated one). A Prisma query here isn't subject to that guard, so
      // this is the only way every role actually sees the Arabic label.
      const gapTypeOptions = await tx.gapTypeOption.findMany();
      const gapTypeArByName = new Map(gapTypeOptions.map((o) => [o.name, o.nameAr]));

      const entries: KpiSeverityEntry[] = [];
      for (const need of needs) {
        const survey = surveyByNeed.get(need.id);
        if (!survey) continue;
        const scoreRow = latestScoreByNeed.get(need.id);

        const mv = survey.methodologyVersion
          ? await tx.methodologyVersion.findFirst({ where: { version: survey.methodologyVersion } })
          : await tx.methodologyVersion.findFirst({ where: { status: 'PUBLISHED' }, orderBy: { createdAt: 'desc' } });
        if (!mv) continue;

        const kpiRollups = await tx.scoreRollup.findMany({
          where: {
            studyId: need.studyId,
            surveyId: survey.id,
            villageId: '',
            methodologyVersionId: mv.id,
            rollupLevel: 'KPI',
          },
        });
        if (kpiRollups.length === 0) continue;

        const questions = await tx.question.findMany({
          where: { methodologyVersionId: mv.id, questionId: { in: kpiRollups.map((r) => r.entityId) } },
          select: { questionId: true, analyticalCategory: true, kpi: true, kpiAr: true },
        });
        const questionById = new Map(questions.map((q) => [q.questionId, q]));

        for (const rollup of kpiRollups) {
          const severity = rollup.severityScore !== null ? Number(rollup.severityScore) : null;
          const question = questionById.get(rollup.entityId);
          entries.push({
            domain,
            // Prefer the Question Bank's own current `kpi` text over the
            // rollup's `entityNameSnapshot` — same string in practice, but
            // only the live Question row carries `kpiAr` alongside it.
            kpi: question?.kpi ?? rollup.entityNameSnapshot,
            kpiAr: question?.kpiAr ?? null,
            severityScore: severity,
            analyticalCategory: question?.analyticalCategory ?? null,
            priorityTier: severity !== null ? mapPriorityLevel(severity, scoreRow?.equityFlagged ?? false, thresholds) : null,
            gapType: scoreRow?.gapType ?? need.gapType ?? null,
            gapTypeAr: gapTypeArByName.get(scoreRow?.gapType ?? need.gapType ?? '') ?? null,
            equityFlag: scoreRow?.equityFlagged ?? false,
            confidence: rollup.confidenceLevel === 'LOW' ? 'low' : 'standard',
            additionalGapTypeLabel: scoreRow?.cycleNote ?? null,
          });
        }
      }

      // Worst first, same convention as domainBreakdown.
      return entries.sort((a, b) => (b.severityScore ?? -1) - (a.severityScore ?? -1));
    });
  }
}

/** Sentinel key for Needs with no Center link — see the loop above. */
const UNPLACED = '(unplaced)';
const UNPLACED_LABEL = '(no centre recorded)';
