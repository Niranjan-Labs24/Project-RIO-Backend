import type { NeedRecord } from "../need-record.types";
import type { RankedNeed } from "./rank-priority-needs";

export interface MethodologyDomain {
  domain: string;
  domainKey: string;
  subDomainCount: number;
}

export interface DomainDistributionRow {
  domain: string;
  domainKey: string;
  needCount: number;
  subDomainsAssessed: number;
  subDomainsDefined: number;
  severityScore: number | null;
  severityBand: string | null;
  assessed: boolean;
}

export interface ExecutiveSummaryBlock {
  totalNeedsExtracted: number;
  quantitativeCount: number;
  qualitativeCount: 0;
  measuredCount: number;
  notMeasurableCount: number;
  domainsAssessed: number;
  domainsInMethodology: number;
  domainDistribution: DomainDistributionRow[];
  topThreeCriticalNeeds: RankedNeed[];
  /** True when no need reached the CRITICAL band — the heading must then read
   *  "highest-severity", not "critical". */
  noCriticalBandReached: boolean;
  /** Stated when fewer than three needs could be ranked. */
  topNeedsShortfallReason: string | null;
  /** Deterministic — composed from the counts above, never LLM-authored. */
  coverageStatement: string;
}

/**
 * The methodology's domains are enumerated from the METHODOLOGY, not from what
 * this survey happened to assess.
 *
 * The 28 Jul report listed only the two covered domains, so a reader reasonably
 * inferred full coverage of a nine-domain methodology. Uncovered domains are now
 * rows with `assessed: false` — present, and visibly empty.
 */
export function composeExecutiveSummary(input: {
  allDomains: MethodologyDomain[];
  needRecords: NeedRecord[];
  rankedNeeds: RankedNeed[];
  domainSeverityByKey: Map<string, number | null>;
  domainBandByKey: Map<string, string | null>;
  subDomainsAssessedByKey: Map<string, number>;
}): ExecutiveSummaryBlock {
  const {
    allDomains,
    needRecords,
    rankedNeeds,
    domainSeverityByKey,
    domainBandByKey,
    subDomainsAssessedByKey,
  } = input;

  const domainDistribution: DomainDistributionRow[] = allDomains.map((d) => {
    const needCount = needRecords.filter((n) => n.domainKey === d.domainKey).length;
    return {
      domain: d.domain,
      domainKey: d.domainKey,
      needCount,
      subDomainsAssessed: subDomainsAssessedByKey.get(d.domainKey) ?? 0,
      subDomainsDefined: d.subDomainCount,
      severityScore: domainSeverityByKey.get(d.domainKey) ?? null,
      severityBand: domainBandByKey.get(d.domainKey) ?? null,
      assessed: needCount > 0,
    };
  });

  const measured = needRecords.filter((n) => n.severityScore !== null).length;
  const domainsAssessed = domainDistribution.filter((d) => d.assessed).length;
  const top = rankedNeeds.slice(0, 3);

  return {
    totalNeedsExtracted: needRecords.length,
    quantitativeCount: needRecords.filter((n) => n.sourceType === "survey").length,
    qualitativeCount: 0,
    measuredCount: measured,
    notMeasurableCount: needRecords.length - measured,
    domainsAssessed,
    domainsInMethodology: allDomains.length,
    domainDistribution,
    topThreeCriticalNeeds: top,
    noCriticalBandReached: !rankedNeeds.some((n) => n.severityBand === "CRITICAL"),
    topNeedsShortfallReason:
      top.length < 3
        ? `Only ${top.length} need(s) carry a measured severity, so fewer than three could be ranked.`
        : null,
    coverageStatement:
      `This survey assessed ${domainsAssessed} of the methodology's ${allDomains.length} domains. ` +
      `${measured} of ${needRecords.length} indicator(s) returned a measurable severity. ` +
      `Domains not assessed carry no score and are shown as such — their absence is not a finding of low need.`,
  };
}
