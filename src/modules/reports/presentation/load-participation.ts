// Village participation share (client feedback point 3): how a study's valid
// responses are spread across villages within each governorate, so a
// governorate figure built from one village's answers reads as such.
//
// Share = a village's VALID responses ÷ the valid responses of its governorate,
// within the study (client confirmation, Oct 2026). "Valid" is scoring's own
// count — the latest OVERALL rollup per survey and village — so the share
// agrees with every other figure in the report. Villages named on the study's
// Needs with no valid responses are listed at 0%.

import { participationStatus, type ParticipationGroup } from './build-presentation';

interface Tx {
  surveyResponse: {
    findMany(args: unknown): Promise<Array<{ governorateIds: string[]; village: string[] }>>;
  };
  need: {
    findMany(
      args: unknown,
    ): Promise<Array<{ village: string[]; needGovernorates: Array<{ governorateId: string }> }>>;
  };
  scoreRollup: {
    findMany(
      args: unknown,
    ): Promise<Array<{ surveyId: string; villageId: string; validResponseCount: number }>>;
  };
  governorate: {
    findMany(args: unknown): Promise<Array<{ id: string; name: string; nameAr: string | null }>>;
  };
}

export async function loadParticipation(
  tx: Tx,
  studyId: string,
  locale: 'en' | 'ar',
  concentratedFromPct?: number,
): Promise<ParticipationGroup[]> {
  const [responses, needs, rollups] = await Promise.all([
    tx.surveyResponse.findMany({
      where: { studyId, exclusionReason: null },
      select: { governorateIds: true, village: true },
    }),
    tx.need.findMany({
      where: { studyId },
      select: { village: true, needGovernorates: { select: { governorateId: true } } },
    }),
    tx.scoreRollup.findMany({
      where: { studyId, rollupLevel: 'OVERALL', NOT: { villageId: '' } },
      select: { surveyId: true, villageId: true, validResponseCount: true },
      orderBy: { calculatedAt: 'desc' },
    }),
  ]);

  // Valid responses per village: the latest rollup of each survey, summed.
  const latest = new Map<string, number>();
  for (const r of rollups) {
    const key = `${r.surveyId}\u0000${r.villageId}`;
    if (!latest.has(key)) latest.set(key, r.validResponseCount);
  }
  const validByVillage = new Map<string, number>();
  for (const [key, n] of latest) {
    const village = key.split('\u0000')[1]!.trim();
    validByVillage.set(village, (validByVillage.get(village) ?? 0) + n);
  }

  // Which governorate(s) each village belongs to: from the study's Needs and
  // from the responses themselves.
  const govsOf = new Map<string, Set<string>>();
  const link = (village: string, gov: string) => {
    const v = village.trim();
    if (!v) return;
    let s = govsOf.get(v);
    if (!s) govsOf.set(v, (s = new Set()));
    s.add(gov);
  };
  for (const need of needs) {
    for (const g of need.needGovernorates) for (const v of need.village) link(v, g.governorateId);
  }
  for (const r of responses) {
    for (const g of r.governorateIds) for (const v of r.village) link(v, g);
  }

  // governorate id -> village -> valid responses
  const counts = new Map<string, Map<string, number>>();
  for (const [village, govs] of govsOf) {
    for (const gov of govs) {
      let m = counts.get(gov);
      if (!m) counts.set(gov, (m = new Map()));
      m.set(village, validByVillage.get(village) ?? 0);
    }
  }
  if (counts.size === 0) return [];

  const govs = await tx.governorate.findMany({
    where: { id: { in: [...counts.keys()] } },
    select: { id: true, name: true, nameAr: true },
  });
  const govName = new Map(govs.map((g) => [g.id, locale === 'ar' ? (g.nameAr ?? g.name) : g.name]));

  const groups: ParticipationGroup[] = [];
  for (const [govId, villages] of counts) {
    const total = [...villages.values()].reduce((n, c) => n + c, 0);
    if (total === 0) continue;
    const withResponses = [...villages.values()].filter((c) => c > 0).length;
    const rows = [...villages.entries()]
      .map(([village, responses]) => {
        const sharePct = Math.round((responses / total) * 1000) / 10;
        return {
          village,
          responses,
          sharePct,
          status:
            responses > 0 ? participationStatus(sharePct, withResponses, concentratedFromPct) : null,
        };
      })
      .sort((a, b) => b.responses - a.responses || a.village.localeCompare(b.village));
    groups.push({ governorate: govName.get(govId) ?? govId, total, rows });
  }
  return groups.sort((a, b) => b.total - a.total);
}
