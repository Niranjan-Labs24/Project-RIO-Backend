// Core Needs Report (RPT18) — the fixed parts of the report's rules.
//
// Client decision, 15 Oct 2026: the approved v5.0 methodology is not changed.
// Its thresholds (minimum respondents, the "don't know" limit, the priority
// tiers) are read from the methodology configuration at generation time —
// see load-core-needs.ts — and never fixed here. Rules the client asked for
// that v5.0 does not define (geographic coverage, concentration, governorate
// minimum share, indicator pairs) are methodology-configuration settings with
// NO value until the methodology owner approves one; until then the report
// states the figure and applies no threshold.
//
// What remains here is presentation: list lengths and the like.

export const CORE_NEEDS_CONFIG = {
  /** Links between indicators: each group compared needs at least this many
   *  valid responses (confirmed 15 Oct 2026). */
  linksMinPerGroup: 30,

  /** Documented need cards shown. */
  needCardsMax: 5,

  /** "Villages with data" shows the top N at Kingdom level (mockup spec). */
  villagesTopAtKingdom: 20,
  /** Ranked needs shown in "What to intervene in, and where". */
  rankedNeedsMax: 10,
} as const;

export type CoreNeedsConfig = typeof CORE_NEEDS_CONFIG;

/** The confidence result of a component and of the report. LOW is the v5.0
 *  methodology's existing flag; MEETS = meets the methodology standard. */
export type ConfidenceResult = "MEETS" | "LOW";

/** What the decision summary recommends. At LOW confidence the first
 *  recommendation is always to complete data collection (confirmed 4b). */
export type CoreDecision = "collectMore" | "prioritise" | "monitor";
export function coreDecisionFor(overall: ConfidenceResult, tier: string | null): CoreDecision {
  if (overall === "LOW") return "collectMore";
  return tier === "CRITICAL" || tier === "HIGH" ? "prioritise" : "monitor";
}
