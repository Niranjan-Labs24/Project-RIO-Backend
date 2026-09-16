// The no-masking rule (METH — Domain Comparison), in ONE place.
//
// "A domain can average Low while hiding a Critical KPI; the max-KPI column
// surfaces it regardless of the average." RIO-RPT-001 turns that into a build
// constraint: any domain-level rollup in the Village / Sector / Region reports
// must carry the max alongside the average.
//
// Until 24 Aug 2026 the rule lived only inside buildDomainRollup (RPT03/RPT09),
// so the three domain-table reports printed the average alone. Both callers now
// derive it here — a second copy is exactly how one table would come to
// disagree with another about which domains are masking.
//
// Pure: no DB, no AI, no I/O — same rule as snapshot-to-content.ts.

import type { SeverityBand } from "../need-record.types";
import { severityBandOf } from "./severity-bands";

/** Band order, worst first. Index 0 is the most severe. */
const BAND_ORDER: SeverityBand[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

export function bandRank(band: SeverityBand | null): number {
  const i = band ? BAND_ORDER.indexOf(band) : -1;
  // An unbanded (unmeasured) domain must never compare as "worse than
  // critical" — it sorts last, and the masking check below skips it entirely.
  return i === -1 ? BAND_ORDER.length : i;
}

/** One scored KPI beneath a domain. `domainKey` is the NORMALIZED methodology
 *  key, so it joins onto DomainComponent.domainCode. */
export interface KpiUnderDomain {
  domainKey: string;
  kpiName: string;
  severityScore: number | null;
}

export interface DomainMasking {
  maxKpiSeverity: number | null;
  maxKpiName: string | null;
  criticalKpiCount: number;
  masksCriticalFinding: boolean;
}

/** What a domain with no measurable KPI beneath it reports. Null, never 0: an
 *  unmeasured domain is not a domain whose worst KPI scored zero, and it masks
 *  nothing — it simply says nothing. */
export const NO_KPI_MASKING: DomainMasking = {
  maxKpiSeverity: null,
  maxKpiName: null,
  criticalKpiCount: 0,
  masksCriticalFinding: false,
};

export function groupKpisByDomain(rows: KpiUnderDomain[]): Map<string, KpiUnderDomain[]> {
  const byDomain = new Map<string, KpiUnderDomain[]>();
  for (const r of rows) {
    const list = byDomain.get(r.domainKey);
    if (list) list.push(r);
    else byDomain.set(r.domainKey, [r]);
  }
  return byDomain;
}

/**
 * The worst KPI beneath one domain, and whether the domain's own average bands
 * milder than it.
 *
 * `domainSeverity` is the AVERAGE the domain row prints. Masking is a
 * comparison of BANDS, not of raw points: a domain averaging 69 (MEDIUM) over a
 * KPI at 71 (CRITICAL) masks; one averaging 71 over a KPI at 95 does not, since
 * a reader already sees CRITICAL.
 */
export function deriveDomainMasking(
  domainSeverity: number | null,
  kpis: KpiUnderDomain[],
): DomainMasking {
  const measured = kpis.filter((k): k is KpiUnderDomain & { severityScore: number } => k.severityScore !== null);
  if (measured.length === 0) return NO_KPI_MASKING;

  const worst = measured.reduce((a, b) => (b.severityScore > a.severityScore ? b : a));
  const domainBand = severityBandOf(domainSeverity);
  const worstKpiBand = severityBandOf(worst.severityScore);

  return {
    maxKpiSeverity: worst.severityScore,
    maxKpiName: worst.kpiName,
    criticalKpiCount: measured.filter((k) => severityBandOf(k.severityScore) === "CRITICAL").length,
    // Only meaningful when both bands exist — see NO_KPI_MASKING.
    masksCriticalFinding:
      domainBand !== null && worstKpiBand !== null && bandRank(worstKpiBand) < bandRank(domainBand),
  };
}
