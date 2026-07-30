import type { NeedRecord, Thresholds } from "../need-record.types";

// Section 4 — Pattern & Intersection Analysis.
//
// The client asked for cross-domain patterns and intersections. The honest
// version of this section on thin data is a stated suppression, not an invented
// pattern: with 4 respondents and 2 assessed domains there is nothing a
// correlation can mean. Candidates that are detected but sit below the threshold
// are listed as "observed, not asserted" so the signal isn't hidden either.
//
// Pure and deterministic — no LLM. Every string here is composed from counts.

export interface PatternAnalysisBlock {
  status: "reported" | "insufficient_data";
  suppressionReason: string | null;
  thresholds: { minResponses: number; minDomains: number };
  crossDomainPatterns: Array<{
    domains: string[];
    pattern: string;
    strength: "strong" | "moderate" | "weak";
    needIds: string[];
  }>;
  intersections: Array<{
    dimensions: string[];
    finding: string;
    affectedGroup: string;
    equityFlag: boolean;
    needIds: string[];
  }>;
  conflicts: Array<{ needIds: string[]; description: string }>;
  gaps: Array<{ domain: string; description: string }>;
  /** Detected but below threshold — shown as "observed, not asserted". */
  observedBelowThreshold: string[];
}

export function composePatternAnalysis(input: {
  needRecords: NeedRecord[];
  validResponseCount: number;
  domainsAssessed: number;
  domainsNotAssessed: string[];
  thresholds: Thresholds;
}): PatternAnalysisBlock {
  const { needRecords, validResponseCount, domainsAssessed, domainsNotAssessed, thresholds: t } = input;

  const thresholdsOut = { minResponses: t.patternMinResponses, minDomains: t.patternMinDomains };

  // Candidates are derived either way — what changes is whether they are
  // asserted as patterns or only listed as observations.
  const candidates = deriveCandidates(needRecords);

  const gaps = domainsNotAssessed.map((domain) => ({
    domain,
    description: `Not assessed by this survey — no questions from ${domain} were asked, so no severity exists for it.`,
  }));

  const intersections = needRecords
    .filter((n) => n.equityFlag && n.equityDetail.evaluable)
    .map((n) => {
      const d = n.equityDetail as Extract<NeedRecord["equityDetail"], { evaluable: true }>;
      return {
        dimensions: [d.dimension],
        finding: `${n.indicatorName}: ${d.spread.toFixed(2)}-point severity spread across ${d.dimension} groups (threshold ${d.threshold}).`,
        affectedGroup: d.mostDisadvantaged,
        equityFlag: true,
        needIds: [n.needId],
      };
    });

  const belowThreshold =
    validResponseCount < t.patternMinResponses || domainsAssessed < t.patternMinDomains;

  if (belowThreshold) {
    return {
      status: "insufficient_data",
      suppressionReason:
        `Pattern analysis requires at least ${t.patternMinResponses} valid responses AND at least ${t.patternMinDomains} assessed domains. ` +
        `This assessment has ${validResponseCount} valid response(s) across ${domainsAssessed} assessed domain(s), so no cross-domain pattern is asserted.`,
      thresholds: thresholdsOut,
      crossDomainPatterns: [],
      // Equity intersections are per-indicator variance, already gated by their
      // own group-size rule — they stand on their own evidence, so they are not
      // suppressed by the cross-domain threshold.
      intersections,
      conflicts: [],
      gaps,
      observedBelowThreshold: candidates.map((c) => `Observed, not asserted: ${c.pattern}`),
    };
  }

  return {
    status: "reported",
    suppressionReason: null,
    thresholds: thresholdsOut,
    crossDomainPatterns: candidates,
    intersections,
    conflicts: [],
    gaps,
    observedBelowThreshold: [],
  };
}

/**
 * Co-occurrence candidates: domains whose measured severities both sit in the
 * same band. Deliberately weak evidence — it is a co-occurrence, not a
 * correlation, and the wording says so.
 */
function deriveCandidates(needRecords: NeedRecord[]): PatternAnalysisBlock["crossDomainPatterns"] {
  const byBand = new Map<string, NeedRecord[]>();
  for (const n of needRecords) {
    if (n.severityBand === null) continue;
    const list = byBand.get(n.severityBand) ?? [];
    list.push(n);
    byBand.set(n.severityBand, list);
  }

  const out: PatternAnalysisBlock["crossDomainPatterns"] = [];
  for (const [band, records] of byBand) {
    const domains = [...new Set(records.map((r) => r.domain))];
    if (domains.length < 2) continue;
    out.push({
      domains,
      pattern: `${records.length} indicators across ${domains.length} domains (${domains.join(", ")}) sit in the ${band} severity band.`,
      // Co-occurrence of bands across a handful of indicators is the weakest
      // possible evidence; calling it anything stronger would overstate it.
      strength: "weak",
      needIds: records.map((r) => r.needId),
    });
  }
  return out;
}
