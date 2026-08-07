import { describe, expect, it } from 'vitest';
import { calculateSampleSize } from './sample-size';

// Reference values from the Methodology workbook's Sample Size Reference
// sheet (±10% margin default), which this implementation must reproduce.
describe('calculateSampleSize', () => {
  it.each([
    [500, 81],
    [999, 88],
    [5000, 94],
    [20000, 96],
    [100000, 96],
    [1000000, 96],
  ])('required sample for population %d is %d', (population, expected) => {
    expect(calculateSampleSize(population).requiredSampleSize).toBe(expected);
  });

  it('MDE at n=94 (population 5000) is ~14.4 percentage points', () => {
    const result = calculateSampleSize(5000);
    expect(result.minimumDetectableEffect).toBeCloseTo(14.4, 1);
  });

  it('MDE at n=96 (population 1,000,000) is ~14.3 percentage points', () => {
    const result = calculateSampleSize(1000000);
    expect(result.minimumDetectableEffect).toBeCloseTo(14.3, 1);
  });

  it('supports a tighter ±5% margin (higher required sample)', () => {
    const result = calculateSampleSize(5000, 0.05);
    expect(result.requiredSampleSize).toBe(357);
  });

  it('rejects a non-positive population', () => {
    expect(() => calculateSampleSize(0)).toThrow();
    expect(() => calculateSampleSize(-5)).toThrow();
  });

  it('rejects an out-of-range margin of error', () => {
    expect(() => calculateSampleSize(5000, 0)).toThrow();
    expect(() => calculateSampleSize(5000, 1)).toThrow();
  });
});
