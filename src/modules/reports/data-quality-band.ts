/**
 * The data-quality band of a study — one rule, shared by every report.
 *
 * Amira's request of 13 Nov 2026, after the meeting with Meshari: "Add
 * filters to generate the report by indicator and data quality, such as
 * including only data rated 'Excellent'." No such rating existed. The
 * closest thing the platform had was the confidence band, which has two
 * values (STANDARD / LOW) and so cannot express "Excellent".
 *
 * The rule is the study's coverage of the sample size the methodology asked
 * of it. Study.requiredSampleSize is computed from the population when the
 * study is created and never recomputed (see StudiesService/sample-size.ts),
 * so it is a fixed target, and the ratio of responses actually collected to
 * that target is a fair reading of how well covered the study is. It needs
 * no new column and no migration.
 *
 * NOT_APPLICABLE is a real answer, not a failure. The schema's own note on
 * requiredSampleSize says the coverage criterion does not apply to some
 * study types, and those leave it null. Banding them as the worst would
 * fail a study against a rule it was never measured by.
 */

export const DATA_QUALITY_BANDS = [
  'excellent',
  'good',
  'adequate',
  'below_threshold',
  'not_applicable',
] as const;

export type DataQualityBand = (typeof DATA_QUALITY_BANDS)[number];

export function isDataQualityBand(value: string): value is DataQualityBand {
  return (DATA_QUALITY_BANDS as readonly string[]).includes(value);
}

/**
 * Where each band starts, as a multiple of the required sample size.
 *
 * Three times the target is "excellent" and twice is "good", the rule the
 * client set. Anything that merely reaches the target is "adequate" — it
 * satisfies the methodology, which is not the same as being a strong
 * sample, and calling that "good" would flatter it.
 */
export const DATA_QUALITY_THRESHOLDS: ReadonlyArray<{
  band: DataQualityBand;
  minRatio: number;
}> = [
  { band: 'excellent', minRatio: 3 },
  { band: 'good', minRatio: 2 },
  { band: 'adequate', minRatio: 1 },
];

export function dataQualityBandFor(
  responseCount: number,
  required: number | null | undefined,
): DataQualityBand {
  if (required == null || required <= 0) return 'not_applicable';
  const ratio = responseCount / required;
  for (const { band, minRatio } of DATA_QUALITY_THRESHOLDS) {
    if (ratio >= minRatio) return band;
  }
  return 'below_threshold';
}

/** For a message a person reads, not a key. */
export function describeBand(band: DataQualityBand): string {
  switch (band) {
    case 'excellent':
      return 'Excellent (3x the required sample or more)';
    case 'good':
      return 'Good (2x the required sample or more)';
    case 'adequate':
      return 'Adequate (the required sample met)';
    case 'below_threshold':
      return 'Below threshold (the required sample not met)';
    case 'not_applicable':
      return 'Not applicable (no required sample size was set for this study)';
  }
}
