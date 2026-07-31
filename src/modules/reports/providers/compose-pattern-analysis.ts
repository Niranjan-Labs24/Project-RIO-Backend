import type { NeedRecord, Thresholds } from "../need-record.types";

// Section 4 — Pattern & Intersection Analysis.
//
// The client asked for cross-domain patterns and intersections. On a thin
// sample the section must do two things at once: show what the data actually
// says, and refuse to dress it up as a finding it cannot support.
//
// The earlier version only did the second half. It looked for co-occurrence
// ACROSS domains, so a single-domain survey produced zero candidates, and the
// whole section rendered as one sentence explaining that nothing was asserted.
// That reads as "no analysis was run" when in fact several real observations
// were available — they just sat inside one domain.
//
// So: observations are now derived at the deepest level the data supports
// (across domains → across sub-domains → within one sub-domain), and are always
// rendered. The response/domain thresholds no longer decide WHETHER to show
// anything; they decide whether the block is `reported` or `provisional`, and
// the caveat text travels with the numbers.
//
// Pure and deterministic — no LLM. Every string here is composed from counts.

export type ObservationScope = "cross_domain" | "cross_sub_domain" | "within_sub_domain";

export interface PatternObservation {
  scope: ObservationScope;
  /** Human label for the scope, e.g. "Within Access to Basic Healthcare". */
  scopeLabel: string;
  pattern: string;
  strength: "strong" | "moderate" | "weak";
  /** What the claim rests on — indicator count and responses behind it. */
  evidence: string;
  domains: string[];
  needIds: string[];
}

export interface ObservedIntersection {
  indicatorName: string;
  dimension: string;
  /** "female 62.50 (n=4), male 41.00 (n=3)" — the real per-group measurements. */
  groupsLabel: string;
  spread: number;
  note: string;
  needIds: string[];
}

export interface PatternAnalysisBlock {
  /** `provisional` = derived from a sample below the assertion thresholds. */
  status: "reported" | "provisional";
  /** Present whenever status is `provisional` — printed WITH the findings. */
  evidenceNote: string | null;
  thresholds: { minResponses: number; minDomains: number };
  patterns: PatternObservation[];
  intersections: Array<{
    dimensions: string[];
    finding: string;
    affectedGroup: string;
    equityFlag: boolean;
    needIds: string[];
  }>;
  /** Group differences measured below the minimum group size — shown, not asserted. */
  observedIntersections: ObservedIntersection[];
  conflicts: Array<{ needIds: string[]; description: string }>;
  gaps: Array<{ domain: string; description: string }>;
}

export function composePatternAnalysis(input: {
  needRecords: NeedRecord[];
  validResponseCount: number;
  domainsAssessed: number;
  domainsNotAssessed: string[];
  thresholds: Thresholds;
}): PatternAnalysisBlock {
  const { needRecords, validResponseCount, domainsAssessed, domainsNotAssessed, thresholds: t } = input;

  const belowThreshold =
    validResponseCount < t.patternMinResponses || domainsAssessed < t.patternMinDomains;

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

  return {
    status: belowThreshold ? "provisional" : "reported",
    evidenceNote: belowThreshold
      ? `Provisional — based on ${validResponseCount} valid response(s) across ${domainsAssessed} assessed domain(s). ` +
        `Assertion thresholds are ${t.patternMinResponses} responses and ${t.patternMinDomains} domains, so the observations below ` +
        `describe this sample only and are not generalised to the population.`
      : null,
    thresholds: { minResponses: t.patternMinResponses, minDomains: t.patternMinDomains },
    patterns: deriveObservations(needRecords, belowThreshold),
    intersections,
    observedIntersections: deriveObservedIntersections(needRecords, t),
    conflicts: [],
    gaps,
  };
}

/**
 * Observations, at the deepest level the data supports.
 *
 * Three families, all computed from measured severities:
 *   1. Band clustering — indicators sharing a severity band.
 *   2. Severity range — how far apart the best and worst measured indicators sit.
 *   3. Measurement gaps — indicators that returned no severity at all.
 *
 * Nothing here is a correlation. With this many respondents nothing can be, and
 * the strength grading says so.
 */
function deriveObservations(needRecords: NeedRecord[], belowThreshold: boolean): PatternObservation[] {
  const measured = needRecords.filter((n) => n.severityScore !== null && n.severityBand !== null);
  const out: PatternObservation[] = [];

  // ── 1. Band clustering ──
  const byBand = new Map<string, NeedRecord[]>();
  for (const n of measured) {
    const list = byBand.get(n.severityBand as string) ?? [];
    list.push(n);
    byBand.set(n.severityBand as string, list);
  }

  for (const [band, records] of byBand) {
    if (records.length < 2) continue;
    const domains = [...new Set(records.map((r) => r.domain))];
    const subDomains = [...new Set(records.map((r) => r.subDomain))];
    const scope: ObservationScope =
      domains.length >= 2 ? "cross_domain" : subDomains.length >= 2 ? "cross_sub_domain" : "within_sub_domain";

    const where =
      scope === "cross_domain"
        ? `across ${domains.length} domains (${domains.join(", ")})`
        : scope === "cross_sub_domain"
          ? `across ${subDomains.length} sub-domains of ${domains[0]} (${subDomains.join(", ")})`
          : `within ${subDomains[0]}`;

    out.push({
      scope,
      scopeLabel: scopeLabelOf(scope, domains, subDomains),
      pattern: `${records.length} indicators ${where} sit in the ${band} severity band.`,
      // Co-occurrence of bands across a handful of indicators is the weakest
      // possible evidence. Only a cross-domain cluster on an adequate sample
      // earns more than "weak", and none of it is ever "strong".
      strength: !belowThreshold && scope === "cross_domain" && records.length >= 3 ? "moderate" : "weak",
      evidence: evidenceOf(records),
      domains,
      needIds: records.map((r) => r.needId),
    });
  }

  // ── 2. Severity range ──
  // A 53-point spread between two indicators of the same sub-domain is the most
  // actionable thing a single-domain survey produces, and the old version never
  // mentioned it.
  if (measured.length >= 2) {
    const sorted = [...measured].sort(
      (a, b) => (b.severityScore as number) - (a.severityScore as number),
    );
    const worst = sorted[0]!;
    const best = sorted[sorted.length - 1]!;
    const spread = (worst.severityScore as number) - (best.severityScore as number);
    if (spread >= 1) {
      const domains = [...new Set(measured.map((r) => r.domain))];
      const subDomains = [...new Set(measured.map((r) => r.subDomain))];
      const scope: ObservationScope =
        domains.length >= 2 ? "cross_domain" : subDomains.length >= 2 ? "cross_sub_domain" : "within_sub_domain";
      out.push({
        scope,
        scopeLabel: scopeLabelOf(scope, domains, subDomains),
        pattern:
          `Measured severity ranges ${(best.severityScore as number).toFixed(2)} (${best.indicatorName}) ` +
          `to ${(worst.severityScore as number).toFixed(2)} (${worst.indicatorName}) — a ${spread.toFixed(2)}-point spread ` +
          `across ${measured.length} indicators. Need is concentrated, not uniform.`,
        strength: "weak",
        evidence: evidenceOf(measured),
        domains,
        needIds: [worst.needId, best.needId],
      });
    }
  }

  // ── 3. Measurement gaps ──
  // An indicator nobody could answer is a finding about the assessment itself.
  const unmeasured = needRecords.filter((n) => n.severityScore === null);
  if (unmeasured.length) {
    const domains = [...new Set(unmeasured.map((r) => r.domain))];
    const subDomains = [...new Set(unmeasured.map((r) => r.subDomain))];
    const scope: ObservationScope =
      domains.length >= 2 ? "cross_domain" : subDomains.length >= 2 ? "cross_sub_domain" : "within_sub_domain";
    out.push({
      scope,
      scopeLabel: scopeLabelOf(scope, domains, subDomains),
      pattern:
        `${unmeasured.length} of ${needRecords.length} indicators returned no severity ` +
        `(${unmeasured.map((r) => r.indicatorName).join(", ")}). Unmeasured is not the same as no need.`,
      strength: "weak",
      evidence: `${unmeasured.length} indicator(s) with no computable severity.`,
      domains,
      needIds: unmeasured.map((r) => r.needId),
    });
  }

  // ── 4. Confidence clustering ──
  const lowConfidence = measured.filter((n) => n.confidence === "LOW");
  if (lowConfidence.length && lowConfidence.length < measured.length) {
    const domains = [...new Set(lowConfidence.map((r) => r.domain))];
    const subDomains = [...new Set(lowConfidence.map((r) => r.subDomain))];
    out.push({
      scope: domains.length >= 2 ? "cross_domain" : "within_sub_domain",
      scopeLabel: scopeLabelOf(
        domains.length >= 2 ? "cross_domain" : "within_sub_domain",
        domains,
        subDomains,
      ),
      pattern:
        `${lowConfidence.length} of ${measured.length} measured indicators carry LOW confidence ` +
        `(${lowConfidence.map((r) => r.indicatorName).join(", ")}) — their severities move most if more responses arrive.`,
      strength: "weak",
      evidence: evidenceOf(lowConfidence),
      domains,
      needIds: lowConfidence.map((r) => r.needId),
    });
  }

  return out;
}

function scopeLabelOf(scope: ObservationScope, domains: string[], subDomains: string[]): string {
  if (scope === "cross_domain") return "Across domains";
  if (scope === "cross_sub_domain") return `Across sub-domains of ${domains[0]}`;
  return `Within ${subDomains[0] ?? domains[0] ?? "this survey"}`;
}

/** Response counts behind an observation — the reader's check on how much it weighs. */
function evidenceOf(records: NeedRecord[]): string {
  const responses = records.map((r) => r.validResponseCount);
  const min = Math.min(...responses);
  const max = Math.max(...responses);
  const range = min === max ? `n=${min}` : `n=${min}–${max}`;
  return `${records.length} indicator(s), ${range} valid responses each.`;
}

/**
 * Equity comparisons that ran but did not clear the minimum group size. These
 * are the real per-group severities; they are listed so a reader can see the
 * direction of a difference, and captioned so nobody quotes them as a finding.
 */
function deriveObservedIntersections(needRecords: NeedRecord[], t: Thresholds): ObservedIntersection[] {
  const out: ObservedIntersection[] = [];
  for (const n of needRecords) {
    const eq = n.equityDetail;
    if (eq.evaluable) continue;
    for (const c of eq.observedComparisons ?? []) {
      const omitted = c.singleRespondentGroupsOmitted
        ? ` ${c.singleRespondentGroupsOmitted} single-respondent group(s) withheld.`
        : "";
      out.push({
        indicatorName: n.indicatorName,
        dimension: c.dimension,
        groupsLabel: c.groups
          .map((g) => `${g.label} ${g.severityScore.toFixed(2)} (n=${g.n})`)
          .join(", "),
        spread: c.spread,
        note:
          `Below the minimum group size of ${t.equityMinGroupN}, so this is not an equity finding.` + omitted,
        needIds: [n.needId],
      });
    }
  }
  return out;
}
