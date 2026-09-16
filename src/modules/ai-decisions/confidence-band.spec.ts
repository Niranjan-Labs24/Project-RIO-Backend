import { describe, it, expect } from 'vitest';
import { isFlaggedConfidence, resolveConfidenceBand } from './confidence-band';
import type { AiClassificationSettings } from '../methodology-config/methodology-config.types';

// The shipped defaults, spelled out rather than imported: these tests are the
// record of what the bands MEAN at a given pair of thresholds, so they must
// not silently follow a future change to the defaults.
const DEFAULTS: AiClassificationSettings = {
  lowConfidenceThreshold: 0.7,
  veryLowConfidenceThreshold: 0.4,
};

describe('resolveConfidenceBand', () => {
  it('bands a confident suggestion as standard', () => {
    expect(resolveConfidenceBand(0.92, DEFAULTS)).toBe('standard');
  });

  it('treats the low threshold itself as standard, not low', () => {
    // Boundary is >= low, so a suggestion sitting exactly on the configured
    // threshold is NOT flagged — "below a configurable threshold" in the
    // acceptance criterion is strict.
    expect(resolveConfidenceBand(0.7, DEFAULTS)).toBe('standard');
  });

  it('bands just under the low threshold as low', () => {
    expect(resolveConfidenceBand(0.69, DEFAULTS)).toBe('low');
  });

  it('treats the very-low threshold itself as low, not very_low', () => {
    expect(resolveConfidenceBand(0.4, DEFAULTS)).toBe('low');
  });

  it('bands below the very-low threshold as very_low', () => {
    expect(resolveConfidenceBand(0.39, DEFAULTS)).toBe('very_low');
  });

  it('bands an AI decline (confidence 0) as very_low, not not_reported', () => {
    // 0 is a real value written by the "AI ran and declined" path — it must
    // stay distinguishable from a missing confidence.
    expect(resolveConfidenceBand(0, DEFAULTS)).toBe('very_low');
  });

  it('bands a missing confidence as not_reported, not as 0', () => {
    // The bug this whole change exists for: `null` used to arrive as 0 and
    // render a good classification in red at 0%.
    expect(resolveConfidenceBand(null, DEFAULTS)).toBe('not_reported');
  });

  it('follows reconfigured thresholds rather than the old hardcoded 0.7/0.4', () => {
    const strict: AiClassificationSettings = {
      lowConfidenceThreshold: 0.95,
      veryLowConfidenceThreshold: 0.8,
    };
    // 0.9 is 'standard' under the defaults and 'low' under a stricter config —
    // this is the whole point of making the thresholds configurable.
    expect(resolveConfidenceBand(0.9, DEFAULTS)).toBe('standard');
    expect(resolveConfidenceBand(0.9, strict)).toBe('low');
    expect(resolveConfidenceBand(0.75, strict)).toBe('very_low');
  });
});

describe('isFlaggedConfidence', () => {
  it('flags every band except standard', () => {
    expect(isFlaggedConfidence('standard')).toBe(false);
    expect(isFlaggedConfidence('low')).toBe(true);
    expect(isFlaggedConfidence('very_low')).toBe(true);
    // An unverifiable confidence is not the same as a good one.
    expect(isFlaggedConfidence('not_reported')).toBe(true);
  });
});
