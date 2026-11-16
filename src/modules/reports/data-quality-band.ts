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
 * The threshold IS the line, decided 16 Nov 2026. A first cut graded in
 * multiples of the target — 3x excellent, 2x good, 1x adequate — which read
 * as four grades of the same single fact and invited an argument about why
 * 2.9x was not excellent. A study either collected the sample the
 * methodology asked of it or it did not, so there are two bands: meeting
 * the target is EXCELLENT, missing it is LOW. Nothing between them.
 *
 * NOT_APPLICABLE is a real answer, not a failure, and not a grade. The
 * schema's own note on requiredSampleSize says the coverage criterion does
 * not apply to some study types, and those leave it null. Banding them LOW
 * would fail a study against a rule it was never measured by, so they are
 * banded apart and are deliberately not offered as a filter — see
 * DATA_QUALITY_FILTERS.
 */

export const DATA_QUALITY_BANDS = ['excellent', 'low', 'not_applicable'] as const;

export type DataQualityBand = (typeof DATA_QUALITY_BANDS)[number];

/**
 * The bands a person may filter a report by: the two grades, not the
 * "we never measured this" case. Asking for "only not applicable" is not a
 * quality question, and a reader who filtered by it would get a report
 * built from exactly the studies the coverage rule cannot speak for.
 */
export const DATA_QUALITY_FILTERS = ['excellent', 'low'] as const;

export function isDataQualityBand(value: string): value is DataQualityBand {
  return (DATA_QUALITY_BANDS as readonly string[]).includes(value);
}

export function isDataQualityFilter(value: string): value is 'excellent' | 'low' {
  return (DATA_QUALITY_FILTERS as readonly string[]).includes(value);
}

/**
 * Where the one band boundary sits, as a multiple of the required sample
 * size. Exactly the target counts as meeting it, so the comparison is >=.
 */
export const DATA_QUALITY_EXCELLENT_MIN_RATIO = 1;

export function dataQualityBandFor(
  responseCount: number,
  required: number | null | undefined,
): DataQualityBand {
  if (required == null || required <= 0) return 'not_applicable';
  return responseCount / required >= DATA_QUALITY_EXCELLENT_MIN_RATIO
    ? 'excellent'
    : 'low';
}

/** For a message a person reads, not a key. */
export function describeBand(band: DataQualityBand): string {
  switch (band) {
    case 'excellent':
      return 'Excellent (the required sample met or exceeded)';
    case 'low':
      return 'Low (the required sample not met)';
    case 'not_applicable':
      return 'Not applicable (no required sample size was set for this study)';
  }
}
