import type { AiClassificationSettings } from '../methodology-config/methodology-config.types';

/**
 * RIO-AI-001 — how a suggestion's self-reported confidence is banded for the
 * reviewer.
 *
 * - `standard`     — at or above the configured low-confidence threshold. No flag.
 * - `low`          — below it. Flagged for closer reviewer attention.
 * - `very_low`     — below the very-low threshold too. Strongest treatment.
 * - `not_reported` — the model classified but returned no confidence at all
 *                    (`AiDecision.confidence` is NULL). Treated as needing
 *                    closer attention, because an unverifiable confidence is
 *                    not the same as a good one.
 *
 * `declined` is deliberately NOT a band here: a confidence of exactly `0` on
 * the "AI ran and declined" path bands as `very_low`, which is the correct
 * visual treatment for it. What distinguishes that case for the reviewer is
 * `Need.allDomainsSelected`, which the UI already surfaces with its own notice.
 */
export type ConfidenceBand = 'standard' | 'low' | 'very_low' | 'not_reported';

/**
 * Decided on the backend, next to the config that parameterises it, and sent
 * to the client as a resolved band — the same convention the report-summary
 * prompts follow ("every band, adjective and threshold is supplied ... already
 * decided by the backend"). The alternative, re-deriving it in the reviewer
 * component, is exactly what left the thresholds hardcoded in the frontend and
 * unconfigurable in the first place.
 */
export function resolveConfidenceBand(
  confidence: number | null,
  settings: AiClassificationSettings,
): ConfidenceBand {
  if (confidence === null) return 'not_reported';
  if (confidence < settings.veryLowConfidenceThreshold) return 'very_low';
  if (confidence < settings.lowConfidenceThreshold) return 'low';
  return 'standard';
}

/** True for every band the reviewer should be pulled towards — i.e. anything
 * that is not plainly fine. Kept beside the band so "which bands count as
 * flagged" is answered once rather than re-listed at each call site (the
 * reviewer UI's badge, and the Needs list's low-confidence filter). */
export function isFlaggedConfidence(band: ConfidenceBand): boolean {
  return band !== 'standard';
}
