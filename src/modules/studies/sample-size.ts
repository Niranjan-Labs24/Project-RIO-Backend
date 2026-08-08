// RIO-FR-024: Sample Size Calculator. Formula and defaults are the
// Methodology workbook's Sample Size Reference sheet, headed "final
// mechanism signed off by Dr. Zulfiqar" — a confirmed requirement, not a
// design choice made here.
//
// n0 = Z² · p(1−p) / e²        Cochran's uncorrected sample (worst-case p=0.5)
// n  = n0 / (1 + (n0−1)/N)     finite population correction for population N
// MDE = (1.4 / √n) × 100       minimum detectable effect, percentage points
//                              (95% confidence, 80% power, worst-case p=0.5)
//
// Verified against the workbook's reference table (N=500→n=81, N=5000→n=94/
// MDE=14.4, N=1,000,000→n=96/MDE=14.3) — rounding is nearest-integer, not
// ceiling.

const Z_95_PERCENT_CONFIDENCE = 1.96;
const WORST_CASE_PROPORTION = 0.5;
const MDE_NUMERATOR = 1.4; // 95% confidence, 80% power, worst-case p=0.5

export const DEFAULT_MARGIN_OF_ERROR = 0.1;

export interface SampleSizeResult {
  population: number;
  marginOfError: number;
  /** Cochran's formula with finite population correction, rounded to the nearest respondent. */
  requiredSampleSize: number;
  /** Minimum Detectable Effect, in percentage points, at requiredSampleSize. */
  minimumDetectableEffect: number;
}

export function calculateSampleSize(
  population: number,
  marginOfError: number = DEFAULT_MARGIN_OF_ERROR,
): SampleSizeResult {
  if (!Number.isInteger(population) || population <= 0) {
    throw new Error('population must be a positive integer');
  }
  if (marginOfError <= 0 || marginOfError >= 1) {
    throw new Error('marginOfError must be between 0 and 1 (exclusive)');
  }

  const n0 = (Z_95_PERCENT_CONFIDENCE ** 2 * WORST_CASE_PROPORTION * (1 - WORST_CASE_PROPORTION)) / marginOfError ** 2;
  const finitePopulationCorrected = n0 / (1 + (n0 - 1) / population);
  const requiredSampleSize = Math.max(1, Math.round(finitePopulationCorrected));
  const minimumDetectableEffect = (MDE_NUMERATOR / Math.sqrt(requiredSampleSize)) * 100;

  return { population, marginOfError, requiredSampleSize, minimumDetectableEffect };
}
