// ============================================================================
// DEPRECATED — DO NOT USE FOR SCORING.
// ============================================================================
//
// This file was the initial placeholder scoring engine (RIO-Priority Cycle 1
// draft). Its formulas were heuristic guesses:
//
//   - YES/NO mapped to 1/0 (ignores per-question lookup tables)
//   - Numeric answers divided by 100 (ignores floor, ceiling, direction)
//   - Any other answer returned a fixed 0.5 "neutral" value
//
// NONE of these formulas are correct for the production methodology.
//
// ✅ THE REAL ENGINE IS: DeterministicScoringService (scoring.service.ts)
//    It resolves every answer against the `ScoringLookup` table seeded from
//    scoring-lookups-baseline.csv using the exact methodology-approved values.
//
// This file is kept only so that TypeScript consumers of the PriorityLevel,
// GapType, and ScoringThresholds types (e.g. the Priority API response DTOs)
// do not need to be updated. The runtime functions below are intentionally
// removed to prevent accidental use.
//
// If you need priority-level thresholds, use DEFAULT_THRESHOLDS below.
// If you need gap-type determination, use mapPriorityLevel() + determineGapType().
// Do NOT import mapResponseValue() or scoreNeed() — they do not exist here
// any more.
// ============================================================================

/** Priority level bands as defined in the methodology brief. */
export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';

/** Gap classification for a detected need gap. */
export type GapType = 'acute' | 'chronic' | 'structural' | 'seasonal' | 'inequity_linked';

export interface ScoringThresholds {
  /** >= this severity is always Critical. */
  criticalSeverity: number;
  /** >= this severity is High. */
  highSeverity: number;
  /**
   * >= this severity AND the equity flag is set is also High (a lower bar
   * than highSeverity so equity-flagged gaps are treated as more urgent).
   */
  equityHighSeverity: number;
  /** >= this severity (and below highSeverity) is Medium; below is Low. */
  mediumSeverity: number;
}

/**
 * Configurable threshold constants matching the methodology spec bands:
 * >=80 Critical | >=70 High | >=50 + equity flag → High | 40-69 Medium | <40 Low
 */
export const DEFAULT_THRESHOLDS: ScoringThresholds = {
  criticalSeverity: 80,
  highSeverity: 70,
  equityHighSeverity: 50,
  mediumSeverity: 40,
};

/**
 * Maps a numeric severity score (0-100) and an equity flag to a PriorityLevel.
 * This is the ONLY function from the original engine still in use — it is
 * a pure threshold lookup with no heuristic behaviour.
 */
export function mapPriorityLevel(
  severity: number,
  hasEquityFlag: boolean,
  thresholds: ScoringThresholds = DEFAULT_THRESHOLDS,
): PriorityLevel {
  if (severity >= thresholds.criticalSeverity) return 'critical';
  if (severity >= thresholds.highSeverity) return 'high';
  if (severity >= thresholds.equityHighSeverity && hasEquityFlag) return 'high';
  if (severity >= thresholds.mediumSeverity) return 'medium';
  return 'low';
}

/**
 * Determines the gap type for a scored need.
 * Cycle 1 always returns 'acute' — multi-cycle trend comparison is not yet
 * implemented (see TODO(RIO-Priority) in the full methodology backlog).
 */
export function determineGapType(level: PriorityLevel, cycleNumber: number = 1): GapType {
  void level; // unused until cycle 2 — suppresses lint warning
  if (cycleNumber === 1) {
    // TODO(RIO-Priority): cycle 1 has no history to compare against, so
    // every high/critical gap is provisionally "acute". Chronic/structural/
    // seasonal/inequity_linked all require a later cycle's trend.
    return 'acute';
  }
  // TODO(RIO-Priority): multi-cycle comparison not implemented yet.
  return 'acute';
}
