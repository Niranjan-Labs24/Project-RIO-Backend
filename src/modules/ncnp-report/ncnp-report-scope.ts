/**
 * The NCNP Compiled Report's two filters — by indicator, and by data quality.
 *
 * Requested by Amira after the meeting with Meshari: "Add filters to generate
 * the NCNP report by indicator and data quality, such as including only data
 * rated 'Excellent'."
 *
 * Neither dimension existed on the report, and neither exists on a Need, so
 * both are derived here rather than stored. Keeping that derivation in one
 * file is the point: the service threads a `where` fragment through forty
 * queries, and the rule those fragments encode has to be readable in one
 * place, not reconstructed from them.
 *
 * DATA QUALITY is the study's coverage against the sample size the
 * methodology asked of it. Study.requiredSampleSize is computed from the
 * population when the study is created and never recomputed (see
 * StudiesService/sample-size.ts), so it is a fixed target: the ratio of
 * responses actually collected to that target is a fair reading of how well
 * covered the study is, and it needs no new column, no migration and no
 * change anywhere outside this report.
 *
 * NOT_APPLICABLE is a real answer, not a failure. The schema's own comment
 * on requiredSampleSize says the coverage criterion does not apply to some
 * study types, and those leave it null. Counting them as the worst band
 * would put a study in the report's "below threshold" list for a rule it was
 * never measured against.
 *
 * INDICATOR comes down the only path the schema offers: a Need has a domain
 * and a sub-domain but no indicator, and `indicator` lives on Question
 * alone. So a need is "under" an indicator when the survey built for it
 * carries a question that measures it — Need -> Survey -> SurveyQuestion ->
 * Question.indicator. That is a touches relation, not a belongs-to: one need
 * usually touches several indicators, and a question the builder wrote by
 * hand has no bank question and so no indicator at all.
 */

/**
 * The band rule now lives in ../reports/data-quality-band.ts, because every
 * report filters on it, not only this one. Re-exported here so the NCNP
 * module's own callers keep one import.
 */
export {
  DATA_QUALITY_BANDS,
  DATA_QUALITY_THRESHOLDS,
  dataQualityBandFor,
  describeBand,
  isDataQualityBand,
  type DataQualityBand as NcnpDataQualityBand,
} from '../reports/data-quality-band';
import { dataQualityBandFor as _band, type DataQualityBand } from '../reports/data-quality-band';
void _band;

export interface NcnpReportFilters {
  /** A Question.indicator, exactly as the question bank spells it. */
  indicator?: string;
  dataQuality?: DataQualityBand;
}

/**
 * Which studies and needs a filtered report may draw on.
 *
 * `null` for either list means "no restriction on this one" and is NOT the
 * same as an empty array, which means the filter matched nothing and the
 * report must come back empty rather than unfiltered. Getting those two
 * confused is how a filter silently stops filtering, so they are different
 * types rather than both being falsy.
 */
export interface NcnpReportScope {
  studyIds: string[] | null;
  needIds: string[] | null;
  /** True when either filter is set — the report says so on its face. */
  active: boolean;
}

export const UNFILTERED: NcnpReportScope = {
  studyIds: null,
  needIds: null,
  active: false,
};

/** Intersect two id lists, treating null as "everything". */
export function intersectIds(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b;
  if (b === null) return a;
  const inB = new Set(b);
  return a.filter((id) => inB.has(id));
}

/**
 * Prisma `where` fragments for the scope.
 *
 * Each returns `{}` when the scope does not restrict that table, so an
 * unfiltered report issues exactly the queries it issued before this
 * existed — spreading an empty object changes nothing.
 */
export function studyWhere(scope: NcnpReportScope): { id?: { in: string[] } } {
  return scope.studyIds === null ? {} : { id: { in: scope.studyIds } };
}

/**
 * A need is in scope when it is in the indicator's list AND belongs to a
 * study the quality band kept.
 *
 * The second half is the one that is easy to miss: filtering by data quality
 * narrows studies, and every need hangs off a study (Need.studyId), so a
 * quality filter has to reach the needs too. Without it the report answered
 * "0 studies" and "68 needs" in the same breath, which is not a subset of
 * anything — it is two different questions on one page.
 */
export function needWhere(scope: NcnpReportScope): {
  id?: { in: string[] };
  studyId?: { in: string[] };
} {
  const where: { id?: { in: string[] }; studyId?: { in: string[] } } = {};
  if (scope.needIds !== null) where.id = { in: scope.needIds };
  if (scope.studyIds !== null) where.studyId = { in: scope.studyIds };
  return where;
}

/** For any table carrying a studyId and/or a needId column. */
export function byStudyAndNeed(scope: NcnpReportScope): {
  studyId?: { in: string[] };
  needId?: { in: string[] };
} {
  const where: { studyId?: { in: string[] }; needId?: { in: string[] } } = {};
  if (scope.studyIds !== null) where.studyId = { in: scope.studyIds };
  if (scope.needIds !== null) where.needId = { in: scope.needIds };
  return where;
}

/**
 * For a table carrying only a needId (NeedDomain, NeedGovernorate,
 * NeedCenter). It reaches the study through its `need` relation, so a
 * quality filter narrows these too.
 */
export function byNeed(scope: NcnpReportScope): {
  needId?: { in: string[] };
  need?: { studyId: { in: string[] } };
} {
  const where: { needId?: { in: string[] }; need?: { studyId: { in: string[] } } } = {};
  if (scope.needIds !== null) where.needId = { in: scope.needIds };
  if (scope.studyIds !== null) where.need = { studyId: { in: scope.studyIds } };
  return where;
}

/** For a table carrying only a studyId. */
export function byStudy(scope: NcnpReportScope): { studyId?: { in: string[] } } {
  return scope.studyIds === null ? {} : { studyId: { in: scope.studyIds } };
}
