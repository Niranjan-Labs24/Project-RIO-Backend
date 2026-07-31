import type { ConfidenceFlag, NeedRecord } from "../need-record.types";
import { deriveTrendNote } from "./derive-trend-note";

// The client's "automatic classification by domain, sub-domain and indicator".
//
// The SUB_DOMAIN and INDICATOR rollups have always been computed and persisted
// (RollupService walks question → KPI → indicator → sub-domain → domain); the
// report snapshot simply never read them, so the report flattened a four-level
// methodology into one list of domains. Nothing new is calculated here — this
// assembles rows that already exist.
//
// Pure: no DB, no AI. Every KPI record attaches to exactly one parent chain, and
// an unmapped KPI lands in an explicit "Unmapped" bucket rather than being
// dropped (asserted by the hierarchy-count invariant).

export interface HierarchyIndicator {
  indicatorId: string;
  indicatorName: string;
  severityScore: number | null;
  confidence: ConfidenceFlag;
  needs: NeedRecord[];
}

export interface HierarchySubDomain {
  subDomain: string;
  subDomainKey: string;
  severityScore: number | null;
  confidence: ConfidenceFlag;
  indicators: HierarchyIndicator[];
}

export interface HierarchyDomain {
  domain: string;
  domainKey: string;
  severityScore: number | null;
  performanceScore: number | null;
  weight: number | null;
  weightedContribution: number | null;
  confidence: ConfidenceFlag;
  confidenceReason: string;
  isCriticalDomain: boolean;
  kpisScored: number;
  kpisAsked: number;
  kpisDefined: number;
  questionsAsked: number;
  trendNote: string;
  subDomains: HierarchySubDomain[];
}

/** A severity + confidence pair read from a SUB_DOMAIN / INDICATOR rollup row. */
export interface RollupLevelValue {
  severityScore: number | null;
  confidence: ConfidenceFlag;
}

export interface DomainMeta {
  domain: string;
  domainKey: string;
  severityScore: number | null;
  performanceScore: number | null;
  weight: number | null;
  weightedContribution: number | null;
  confidence: ConfidenceFlag;
  confidenceReason: string;
  isCriticalDomain: boolean;
  /** KPIs the methodology defines under this domain. */
  kpisDefined: number;
  /** Questions in THIS survey that belong to this domain. */
  questionsAsked: number;
  /** Same domain, previous cycle — null when no prior rollup is stored. */
  priorCycleSeverity: number | null;
}

export function buildNeedHierarchy(input: {
  needRecords: NeedRecord[];
  domainMetaByKey: Map<string, DomainMeta>;
  /** Keyed by sub-domain name (the SUB_DOMAIN rollup's entityId). */
  subDomainByKey: Map<string, RollupLevelValue>;
  /** Keyed by indicator name (the INDICATOR rollup's entityId). */
  indicatorByKey: Map<string, RollupLevelValue>;
  assessmentCycle: number;
}): HierarchyDomain[] {
  const { needRecords, domainMetaByKey, subDomainByKey, indicatorByKey, assessmentCycle } = input;

  // Seeded from the DOMAIN rollups, so the tree has exactly one row per scored
  // domain — the figure the coverage tile counts. A domain whose KPI rollups
  // could not be classified still gets its row (severity and all) rather than
  // disappearing from the table while the tile above kept counting it.
  const domains = new Map<string, Map<string, Map<string, NeedRecord[]>>>();
  for (const key of domainMetaByKey.keys()) {
    domains.set(key, new Map<string, Map<string, NeedRecord[]>>());
  }

  // Then group the records by domain → sub-domain → indicator, preserving
  // first-seen order so the tree is stable across regenerations.
  for (const r of needRecords) {
    const subs = domains.get(r.domainKey) ?? new Map<string, Map<string, NeedRecord[]>>();
    domains.set(r.domainKey, subs);
    const inds = subs.get(r.subDomainKey) ?? new Map<string, NeedRecord[]>();
    subs.set(r.subDomainKey, inds);
    const list = inds.get(r.indicatorId) ?? [];
    list.push(r);
    inds.set(r.indicatorId, list);
  }

  const out: HierarchyDomain[] = [];

  for (const [domainKey, subs] of domains) {
    const meta = domainMetaByKey.get(domainKey);
    // A seeded domain with no classified records has no record to read a name
    // from; its meta supplies one. An unmapped bucket has records but no meta.
    const firstSub = [...subs.values()][0];
    const anyRecord = firstSub ? [...firstSub.values()][0]![0]! : null;
    if (!meta && !anyRecord) continue;

    const subDomains: HierarchySubDomain[] = [];
    for (const [subDomainKey, inds] of subs) {
      const first = [...inds.values()][0]![0]!;
      const sub = subDomainByKey.get(first.subDomain);

      const indicators: HierarchyIndicator[] = [];
      for (const [indicatorId, needs] of inds) {
        const ind = indicatorByKey.get(needs[0]!.indicatorName);
        indicators.push({
          indicatorId,
          indicatorName: needs[0]!.indicatorName,
          // Prefer the persisted INDICATOR rollup; fall back to the KPI record
          // itself, which for this methodology is 1:1 with its indicator.
          severityScore: ind ? ind.severityScore : needs[0]!.severityScore,
          confidence: ind ? ind.confidence : needs[0]!.confidence,
          needs,
        });
      }

      subDomains.push({
        subDomain: first.subDomain,
        subDomainKey,
        severityScore: sub ? sub.severityScore : meanOrNull(indicators.map((i) => i.severityScore)),
        confidence:
          sub?.confidence ?? (indicators.some((i) => i.confidence === "LOW") ? "LOW" : "STANDARD"),
        indicators,
      });
    }

    const allNeeds = subDomains.flatMap((s) => s.indicators.flatMap((i) => i.needs));
    const kpisScored = allNeeds.filter((n) => n.severityScore !== null).length;

    out.push({
      domain: meta?.domain ?? anyRecord!.domain,
      domainKey,
      severityScore: meta ? meta.severityScore : meanOrNull(subDomains.map((s) => s.severityScore)),
      performanceScore: meta?.performanceScore ?? null,
      weight: meta?.weight ?? null,
      weightedContribution: meta?.weightedContribution ?? null,
      confidence: meta?.confidence ?? (allNeeds.some((n) => n.confidence === "LOW") ? "LOW" : "STANDARD"),
      confidenceReason: meta?.confidenceReason ?? allNeeds[0]?.confidenceReason ?? "",
      isCriticalDomain: meta?.isCriticalDomain ?? false,
      kpisScored,
      kpisAsked: allNeeds.length,
      kpisDefined: meta?.kpisDefined ?? allNeeds.length,
      questionsAsked: meta?.questionsAsked ?? 0,
      trendNote: deriveTrendNote({
        assessmentCycle,
        currentSeverity: meta?.severityScore ?? null,
        priorCycleSeverity: meta?.priorCycleSeverity ?? null,
        scopeLabel: "this domain",
      }),
      subDomains,
    });
  }

  // Most severe domain first; unmeasured domains last rather than sorted as 0.
  return out.sort((a, b) => (b.severityScore ?? -1) - (a.severityScore ?? -1));
}

/** Mean of the measured values only. All-null in → null out, never 0. */
function meanOrNull(values: Array<number | null>): number | null {
  const measured = values.filter((v): v is number => v !== null);
  if (measured.length === 0) return null;
  return measured.reduce((a, b) => a + b, 0) / measured.length;
}
