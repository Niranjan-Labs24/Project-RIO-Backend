import { describe, expect, it } from 'vitest';
import { assessResponseQuality } from './response-quality.placeholder';

const settings = { dontKnowRatioThreshold: 0.2, minRespondentsForStandardConfidence: 10 };
const responses = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, answers: { q1: `a${i}` }, contact: `c${i}` }));

describe('assessResponseQuality confidence flag', () => {
  // Methodology Settings fix: the study's required sample feeds the flag.
  it('is low below the required sample even above the 10-respondent floor', () => {
    expect(assessResponseQuality(responses(27), settings, 33)[0]!.confidenceFlag).toBe('low');
    expect(assessResponseQuality(responses(33), settings, 33)[0]!.confidenceFlag).toBe('standard');
    expect(assessResponseQuality(responses(27), settings, null)[0]!.confidenceFlag).toBe('standard');
  });
});
