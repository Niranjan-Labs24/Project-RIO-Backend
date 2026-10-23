// NCNP feedback point 3: a governorate figure built from one village's answers
// must read as such. Each row of the geographic breakdown's village table gets
// its share of its governorate's VALID responses and the concentration flag,
// taken from the participation figures (load-participation.ts) so the table and
// the participation card always agree. Derived on read, so existing reports
// show it too. Without participation figures (none loaded), the table's own
// response counts are used as before.

import { participationStatus, type ParticipationGroup } from './build-presentation';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function withGovernorateShare(
  content: Record<string, unknown>,
  participation?: ParticipationGroup[] | null,
): Record<string, unknown> {
  if (!Array.isArray(content.villages)) return content;

  if (participation?.length) {
    const byVillage = new Map<string, { sharePct: number; status: string | null }>();
    for (const g of participation) {
      for (const r of g.rows) byVillage.set(r.village.trim(), { sharePct: r.sharePct, status: r.status });
    }
    return {
      ...content,
      villages: content.villages.map((r) => {
        if (!isObj(r)) return r;
        const p = byVillage.get(typeof r.village === 'string' ? r.village.trim() : '');
        return {
          ...r,
          governorateSharePct: p ? p.sharePct : null,
          governorateShareStatus: p ? p.status : null,
        };
      }),
    };
  }

  const rows = content.villages.filter(isObj);
  const count = (r: Record<string, unknown>): number =>
    typeof r.responseCount === 'number' && Number.isFinite(r.responseCount) ? r.responseCount : 0;
  const gov = (r: Record<string, unknown>) => (typeof r.governorate === 'string' ? r.governorate : '');
  const totals = new Map<string, number>();
  const withResponses = new Map<string, number>();
  for (const r of rows) {
    totals.set(gov(r), (totals.get(gov(r)) ?? 0) + count(r));
    if (count(r) > 0) withResponses.set(gov(r), (withResponses.get(gov(r)) ?? 0) + 1);
  }
  return {
    ...content,
    villages: content.villages.map((r) => {
      if (!isObj(r)) return r;
      const total = totals.get(gov(r)) ?? 0;
      const pct = total > 0 ? Math.round((count(r) / total) * 1000) / 10 : null;
      return {
        ...r,
        governorateSharePct: pct,
        governorateShareStatus:
          pct != null && count(r) > 0 ? participationStatus(pct, withResponses.get(gov(r)) ?? 0) : null,
      };
    }),
  };
}
