import { ROLE_KEYS } from '../../rbac/role-keys';
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
const CROSS_ENTITY_COMPARISON_ROLES = new Set<string>([ROLE_KEYS.systemAdmin, ROLE_KEYS.systemReviewer, ROLE_KEYS.centerSupervisor]);

/**
 * RIO-FR-005 — comparing places against each other. NOT used by RIO-FR-008's
 * map, which has its own, separate aggregation — client-confirmed
 * (2026-09-24) that a village-first grouping change here must not touch
 * that screen.
 *
 * ─── Village-first, Center, then Governorate — client-confirmed 2026-09-24 ──
 * `Need.village` is free text a researcher types — nothing validates it, and
 * the same place can be spelled several ways (Sprint 3 clarifications Q2).
 * This screen used to group on Center exclusively for exactly that reason,
 * reporting village names as labels underneath — but that produced its own,
 * more visible bug: one real village linked across several Centers (a single
 * Need entered against multiple Centers, or several Needs at the same
 * village but different Centers) rendered as that many separate, seemingly
 * duplicate cards/columns all bearing the identical village name, which a
 * reviewer reads as an actual duplication bug, not as "N real places that
 * happen to share a name" (see disambiguateVillageLabels' now-superseded
 * comment on the frontend, which tried to reframe the duplicate reading by
 * appending the Center name rather than removing the duplication itself).
 *
 * The client's explicit instruction: when a Need names at least one
 * village, group ON that village name (case/whitespace-insensitively) —
 * every Need across every Center that names it collapses into one card.
 * Only fall back to Center when a Need has no village at all, and to
 * Governorate when it has neither (this last case should mostly stop
 * occurring going forward, since Need creation now requires both — see
 * NeedsService — but old data or a governorate with zero Centers can still
 * reach it).
 *
 * This does reintroduce the original typo risk this file's Center-grouping
 * existed to avoid — two spellings of the same place still produce two
 * cards — but that's the accepted, explicit trade-off per this instruction.
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

    const { needs, scores, centers, governorates, thresholds } = await runner(async (tx) => {
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
        include: {
          needCenters: { select: { centerId: true } },
          needGovernorates: { select: { governorateId: true } },
        },
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

      // Governorate fallback (see this file's header comment) — only reached
      // by a Need with no Center at all, which Need creation now blocks
      // going forward (see NeedsService), so this covers pre-existing data
      // and a governorate with zero Centers configured.
      const governorateIds = [
        ...new Set(needs.flatMap((n) => n.needGovernorates.map((g) => g.governorateId))),
      ];
      const governorates = governorateIds.length
        ? await tx.governorate.findMany({
            where: { id: { in: governorateIds } },
            select: {
              id: true,
              name: true,
              nameAr: true,
              region: { select: { name: true, nameAr: true } },
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

      return { needs, scores, centers, governorates, thresholds };
    });

    const latestScoreByNeed = new Map<string, PriorityScoreRow>();
    for (const row of scores as unknown as PriorityScoreRow[]) {
      if (!latestScoreByNeed.has(row.needId)) latestScoreByNeed.set(row.needId, row);
    }
    const centerById = new Map(centers.map((c) => [c.id, c]));
    const governorateById = new Map(governorates.map((g) => [g.id, g]));

    // Contributing Centre names per village-keyed entry — a village-keyed
    // entry has no single Centre of its own (that's the whole point: it
    // merges however many Centres named that same village), so its
    // `centerName` display value is built up here across every Need that
    // contributes to it, then joined once after the main loop.
    const contributingCenterNames = new Map<string, Set<string>>();

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

      // Village-first, then Centre, then Governorate — see this file's
      // header comment. A Need contributes to exactly ONE kind of place per
      // this precedence (a village-carrying Need does not ALSO get grouped
      // by its Centres — the client's explicit instruction is that the
      // village fully replaces the Centre split when one is given, not that
      // both should show).
      type PlaceKey = { key: string; kind: 'village' | 'center' | 'governorate' | 'unplaced'; label?: string };
      const villageNames = need.village.filter((v): v is string => Boolean(v && v.trim()));
      const linked: PlaceKey[] =
        villageNames.length > 0
          ? // Case/whitespace-insensitive key so "Al Kharj" and "al  kharj "
            // collapse into one card; the FIRST original-cased spelling
            // encountered becomes the display label.
            [...new Map(villageNames.map((v) => [normalizeVillageKey(v), v])).entries()].map(
              ([normalized, label]) => ({ key: `village:${normalized}`, kind: 'village', label }),
            )
          : need.needCenters.length > 0
            ? need.needCenters.map((c) => ({ key: c.centerId, kind: 'center' as const }))
            : need.needGovernorates.length > 0
              ? need.needGovernorates.map((g) => ({ key: `governorate:${g.governorateId}`, kind: 'governorate' as const }))
              : [{ key: UNPLACED, kind: 'unplaced' as const }];

      for (const place of linked) {
        const { key: placeKey, kind } = place;
        let entry = byCenter.get(placeKey);
        if (!entry) {
          const center = kind === 'center' ? centerById.get(placeKey) : undefined;
          const governorate =
            kind === 'governorate' ? governorateById.get(placeKey.slice('governorate:'.length)) : undefined;
          entry = {
            centerId: placeKey,
            // Village-keyed: filled in after the main loop from
            // contributingCenterNames, once every Need that contributes to
            // it has been seen. Governorate-keyed: the governorate's own
            // name stands in as the heading (villages stays empty, so the
            // frontend's "no village" heading branch renders this).
            centerName: kind === 'governorate' ? (governorate?.name ?? UNPLACED_LABEL) : (center?.name ?? UNPLACED_LABEL),
            // Village-keyed: filled in the same place as `centerName` above,
            // from contributingCenterNames. Governorate-keyed has no real
            // Centre at all (that's why it fell back this far) — empty,
            // same as an unplaced Need, so the frontend's Centre caption
            // just doesn't render rather than showing the Governorate's own
            // name twice.
            centerNames: kind === 'center' ? [center?.name ?? UNPLACED_LABEL] : kind === 'unplaced' ? [UNPLACED_LABEL] : [],
            centerNameAr: kind === 'governorate' ? (governorate?.nameAr ?? null) : (center?.nameAr ?? null),
            governorateName: kind === 'governorate' ? (governorate?.name ?? null) : (center?.governorate.name ?? null),
            governorateNameAr: kind === 'governorate' ? (governorate?.nameAr ?? null) : (center?.governorate.nameAr ?? null),
            regionName: kind === 'governorate' ? (governorate?.region?.name ?? null) : (center?.governorate.region?.name ?? null),
            regionNameAr: kind === 'governorate' ? (governorate?.region?.nameAr ?? null) : (center?.governorate.region?.nameAr ?? null),
            // Set once, here, from whichever Need's contribution created
            // this entry first — never appended to again below. A village
            // entry's key is already normalized (case/whitespace-
            // insensitive), so every other Need that maps to the same key
            // necessarily spells it close enough that re-adding its own
            // raw spelling would just be a near-duplicate label, not a
            // second real village (see normalizeVillageKey).
            villages: kind === 'village' && place.label ? [place.label] : [],
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
          byCenter.set(placeKey, entry);
          totals.set(placeKey, { sum: 0, count: 0 });
          domainTotals.set(placeKey, new Map());
          if (kind === 'village') contributingCenterNames.set(placeKey, new Set());
        }

        if (!entry.studyIds.includes(need.studyId)) entry.studyIds.push(need.studyId);

        if (kind === 'village') {
          // This Need may ALSO carry Centre links (typically does — the
          // village text describes a place inside one or more of them);
          // those feed this village-entry's displayed Centre list rather
          // than becoming their own separate entries (see precedence above).
          const names = contributingCenterNames.get(placeKey)!;
          for (const nc of need.needCenters) {
            const c = centerById.get(nc.centerId);
            if (c) {
              names.add(c.name);
              // Best-effort governorate/region for a village entry: the
              // first contributing Centre's. A merged village could in
              // theory span more than one Governorate (different Centres
              // in different Governorates both describing "the same"
              // village name) — rare, and not worth a multi-valued field
              // for.
              if (!entry.governorateName) {
                entry.governorateName = c.governorate.name;
                entry.governorateNameAr = c.governorate.nameAr;
                entry.regionName = c.governorate.region?.name ?? null;
                entry.regionNameAr = c.governorate.region?.nameAr ?? null;
              }
            }
          }
        }

        entry.totalNeedCount += 1;
        entry.needTypeCounts[domainKey] = (entry.needTypeCounts[domainKey] ?? 0) + 1;

        if (effective !== null) {
          const t = totals.get(placeKey)!;
          t.sum += effective;
          t.count += 1;
          entry.scoredNeedCount += 1;

          const perDomain = domainTotals.get(placeKey)!;
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

    // Village-keyed entries only got their heading (`villages`) filled in
    // above — their `centerName` display value (the "Centre:" caption the
    // frontend shows underneath) is the join of every distinct Centre name
    // that contributed to them, computed now that every Need has been seen.
    for (const [placeKey, names] of contributingCenterNames) {
      const entry = byCenter.get(placeKey)!;
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      entry.centerName = sorted.length > 0 ? sorted.join(', ') : UNPLACED_LABEL;
      entry.centerNames = sorted;
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
   * RIO-FR-005 — heat map side panel, per the product team's request
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
      // Same village/Centre/Governorate precedence as aggregateByCenter (see
      // this file's header comment) — a Need with a village is never also
      // matched here under its Centre or Governorate, since it isn't
      // credited to that entry's totals either.
      const needs = centerId.startsWith('village:')
        ? (
            await tx.need.findMany({
              where: { studyId: { in: studyIds }, domain, ...EXCLUDE_MERGED, village: { isEmpty: false } },
            })
          ).filter((n) => n.village.some((v) => v && `village:${normalizeVillageKey(v)}` === centerId))
        : centerId.startsWith('governorate:')
          ? await tx.need.findMany({
              where: {
                studyId: { in: studyIds },
                domain,
                ...EXCLUDE_MERGED,
                village: { isEmpty: true },
                needCenters: { none: {} },
                needGovernorates: { some: { governorateId: centerId.slice('governorate:'.length) } },
              },
            })
          : await tx.need.findMany({
              where: {
                studyId: { in: studyIds },
                domain,
                ...EXCLUDE_MERGED,
                village: { isEmpty: true },
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

/** Sentinel key for Needs with no Center/Governorate link at all — see the
 *  loop above. */
const UNPLACED = '(unplaced)';
const UNPLACED_LABEL = '(no centre recorded)';

/** Case/whitespace-insensitive key for grouping by village name — collapses
 *  "Al Kharj" / "al  kharj " / "AL KHARJ" into one card. Not fuzzy beyond
 *  that (no typo-correction): the client's explicit instruction accepts that
 *  trade-off (see this file's header comment) rather than the previous
 *  Centre-only grouping. Exported so kpiBreakdownForDomain can recompute the
 *  same key against a village-keyed centerId parameter without needing the
 *  original aggregation's in-memory state. */
export function normalizeVillageKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
