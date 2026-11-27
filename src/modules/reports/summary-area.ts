// UAT PRI-07 — Governorate and Centre beside Village in "Generate summary".
//
// Client decision (Bhavya, 27 Nov 2026): they FILTER the summary, not just
// label it. The filter is where each respondent said they live
// (SurveyResponse.governorateIds / centerIds, recorded at submission from the
// study's own geography — see CitizenService), so a governorate summary is
// built only from the respondents in that governorate.
//
// No rollup is stored per governorate/centre. ScoreRollup's villageId column
// is read as "a village" by several screens (village comparison, the
// participation table, PriorityV2's per-village pass), so a governorate key
// stored there would show up as a fake village. Instead the summary runs the
// same roll-up maths (computeRollups) on the respondent subset, in memory.
import { BadRequestException } from '@nestjs/common';
import { Prisma, type ScoreRollup, type VillagePriorityAssessment } from '../../generated/prisma';
import type { ComputedRollup, RollupScoreInput } from '../priority/rollup-compute';
import { computeVillagePriority, normalizeDomainKey } from '../priority/priority-v2.service';

export interface SummaryAreaFilter {
  kind: 'GOVERNORATE' | 'CENTER';
  id: string;
}

export interface SummaryArea extends SummaryAreaFilter {
  name: string;
  governorate: { id: string; name: string; regionId: string; regionName: string };
  center: { id: string; name: string } | null;
}

/**
 * The area a VILLAGE-scope summary is narrowed to, or null. Only one area
 * applies: a village pick keeps the stored per-village rollups, and a centre
 * is narrower than a governorate, so it wins when both are sent.
 */
export function areaFilterOf(
  scope: string,
  filters: { villageId?: string; governorateId?: string; centerId?: string },
): SummaryAreaFilter | null {
  if (scope !== 'VILLAGE' || filters.villageId) return null;
  const centerId = filters.centerId?.trim();
  if (centerId) return { kind: 'CENTER', id: centerId };
  const governorateId = filters.governorateId?.trim();
  if (governorateId) return { kind: 'GOVERNORATE', id: governorateId };
  return null;
}

/** Names for the area (Governorate/Center are global reference data). */
export async function loadSummaryArea(
  tx: Prisma.TransactionClient,
  filter: SummaryAreaFilter,
): Promise<SummaryArea> {
  if (filter.kind === 'CENTER') {
    const center = await tx.center.findUnique({
      where: { id: filter.id },
      include: { governorate: { include: { region: true } } },
    });
    if (!center) throw new BadRequestException('Unknown centre. Choose a centre from the list.');
    return {
      ...filter,
      name: center.name,
      governorate: {
        id: center.governorate.id,
        name: center.governorate.name,
        regionId: center.governorate.regionId,
        regionName: center.governorate.region.name,
      },
      center: { id: center.id, name: center.name },
    };
  }
  const governorate = await tx.governorate.findUnique({
    where: { id: filter.id },
    include: { region: true },
  });
  if (!governorate) throw new BadRequestException('Unknown governorate. Choose a governorate from the list.');
  return {
    ...filter,
    name: governorate.name,
    governorate: {
      id: governorate.id,
      name: governorate.name,
      regionId: governorate.regionId,
      regionName: governorate.region.name,
    },
    center: null,
  };
}

/** Prisma `where` fragment selecting the respondents who live in the area. */
export function responseAreaWhere(area: SummaryAreaFilter): Prisma.SurveyResponseWhereInput {
  return area.kind === 'CENTER' ? { centerIds: { has: area.id } } : { governorateIds: { has: area.id } };
}

/**
 * One score per (response, question). Scoring writes a copy of every answer's
 * score for EACH village the need names (see recalculateStudyScores), so a
 * need with two villages holds every respondent twice; a respondent subset
 * must count each person once.
 */
export function dedupeResponseScores<T extends RollupScoreInput & { surveyResponseId: string }>(scores: T[]): T[] {
  const seen = new Set<string>();
  return scores.filter((s) => {
    const key = `${s.surveyResponseId}|${s.questionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Computed rows in the stored ScoreRollup shape, so the snapshot code reads both alike. */
export function toScoreRollups(
  rows: ComputedRollup[],
  ids: { orgId: string; studyId: string; surveyId: string; methodologyVersionId: string },
): ScoreRollup[] {
  const calculatedAt = new Date();
  return rows.map((r) => ({
    id: '',
    ...ids,
    villageId: '',
    rollupLevel: r.rollupLevel,
    entityId: r.entityId,
    entityNameSnapshot: r.entityNameSnapshot,
    severityScore: r.severityScore !== null ? new Prisma.Decimal(r.severityScore) : null,
    validResponseCount: r.validResponseCount,
    excludedResponseCount: r.excludedResponseCount,
    dontKnowCount: r.dontKnowCount,
    dontKnowRate: new Prisma.Decimal(r.dontKnowRate),
    notApplicableCount: r.notApplicableCount,
    confidenceLevel: r.confidenceLevel,
    calculatedAt,
    calculationVersion: 'v1-area',
  }));
}

/** The stored Top KPIs query, in memory: highest severity first, unscored last, 10 rows. */
export function topKpiRollups(kpis: ScoreRollup[], sectorKpis: Set<string> | null, take = 10): ScoreRollup[] {
  return kpis
    .filter((k) => !sectorKpis || sectorKpis.has(k.entityId))
    .sort((a, b) => {
      if (a.severityScore === null && b.severityScore === null) return 0;
      if (a.severityScore === null) return 1;
      if (b.severityScore === null) return -1;
      return Number(b.severityScore) - Number(a.severityScore);
    })
    .slice(0, take);
}

/**
 * The area's priority assessment, built exactly as PriorityV2Service builds a
 * village's (same configs, same computeVillagePriority) but not stored. Null
 * when no domain config or no scored domain applies — as for a village.
 */
export function areaPriorityAssessment(
  configs: Array<{
    domainKey: string;
    domainNameSnapshot: string;
    weight: { toString(): string } | number;
    isCriticalDomain: boolean;
    criticalPerformanceThreshold: number;
  }>,
  domainRollups: ScoreRollup[],
  ids: { orgId: string; studyId: string; surveyId: string; methodologyVersionId: string },
): VillagePriorityAssessment | null {
  if (configs.length === 0) return null;
  const domainScores = new Map<string, number>();
  for (const rollup of domainRollups) {
    if (rollup.severityScore !== null) domainScores.set(normalizeDomainKey(rollup.entityId), Number(rollup.severityScore));
  }
  const result = computeVillagePriority(
    configs.map((c) => ({
      domainKey: normalizeDomainKey(c.domainKey),
      domainNameSnapshot: c.domainNameSnapshot,
      weight: Number(c.weight),
      isCriticalDomain: c.isCriticalDomain,
      criticalPerformanceThreshold: c.criticalPerformanceThreshold,
    })),
    domainScores,
  );
  if (result.domainComponents.length === 0) return null;
  return {
    id: '',
    ...ids,
    villageId: '',
    priorityScore: new Prisma.Decimal(result.priorityScore),
    priorityStatus: result.priorityStatus,
    overrideApplied: result.overrideApplied,
    overrideReason: result.overrideReason,
    // Read back through fromJson like a stored row, so a plain JSON copy.
    domainComponents: JSON.parse(JSON.stringify(result.domainComponents)) as Prisma.JsonValue,
    calculatedAt: new Date(),
    calculationVersion: 'v2-area',
  };
}

export interface SummaryAreaOption {
  id: string;
  name: string;
  nameAr: string | null;
  responseCount: number;
}

/**
 * The governorates and centres this survey's respondents live in, with how
 * many (valid) responses each holds — the only areas worth offering, since any
 * other pick would have no data to summarise.
 */
export async function listSummaryAreas(
  tx: Prisma.TransactionClient,
  needId: string,
): Promise<{ governorates: SummaryAreaOption[]; centers: Array<SummaryAreaOption & { governorateId: string }> }> {
  const responses = await tx.surveyResponse.findMany({
    where: { needId, exclusionReason: null },
    select: { governorateIds: true, centerIds: true },
  });
  const govCount = new Map<string, number>();
  const centerCount = new Map<string, number>();
  for (const r of responses) {
    for (const id of new Set(r.governorateIds)) govCount.set(id, (govCount.get(id) ?? 0) + 1);
    for (const id of new Set(r.centerIds)) centerCount.set(id, (centerCount.get(id) ?? 0) + 1);
  }
  const [governorates, centers] = await Promise.all([
    govCount.size
      ? tx.governorate.findMany({
          where: { id: { in: [...govCount.keys()] } },
          select: { id: true, name: true, nameAr: true },
        })
      : [],
    centerCount.size
      ? tx.center.findMany({
          where: { id: { in: [...centerCount.keys()] } },
          select: { id: true, name: true, nameAr: true, governorateId: true },
        })
      : [],
  ]);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    governorates: governorates.map((g) => ({ ...g, responseCount: govCount.get(g.id) ?? 0 })).sort(byName),
    centers: centers.map((c) => ({ ...c, responseCount: centerCount.get(c.id) ?? 0 })).sort(byName),
  };
}
