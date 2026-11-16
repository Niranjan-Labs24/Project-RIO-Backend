import { describe, expect, it } from 'vitest';
import {
  byNeed,
  byStudy,
  byStudyAndNeed,
  dataQualityBandFor,
  intersectIds,
  isDataQualityBand,
  isDataQualityFilter,
  needWhere,
  studyWhere,
  UNFILTERED,
  type NcnpReportScope,
} from './ncnp-report-scope';

describe('dataQualityBandFor', () => {
  it('bands a study on whether it met the required sample size', () => {
    // The threshold is the only line: meeting the target is excellent,
    // missing it is low. There is nothing in between, so a study that
    // collected three times the target is not graded above one that
    // collected exactly the target.
    expect(dataQualityBandFor(100, 100)).toBe('excellent'); // exactly the target
    expect(dataQualityBandFor(101, 100)).toBe('excellent');
    expect(dataQualityBandFor(300, 100)).toBe('excellent');
    expect(dataQualityBandFor(5000, 100)).toBe('excellent');
    expect(dataQualityBandFor(99, 100)).toBe('low'); // one short
    expect(dataQualityBandFor(50, 100)).toBe('low');
    expect(dataQualityBandFor(0, 100)).toBe('low');
  });

  it('is not_applicable where the study was never given a target', () => {
    // The schema's own note: the coverage criterion does not apply to some
    // study types, and those leave requiredSampleSize null. Banding them
    // low would fail them against a rule never applied to them.
    expect(dataQualityBandFor(0, null)).toBe('not_applicable');
    expect(dataQualityBandFor(5000, null)).toBe('not_applicable');
    expect(dataQualityBandFor(10, undefined)).toBe('not_applicable');
    expect(dataQualityBandFor(10, 0)).toBe('not_applicable');
    expect(dataQualityBandFor(10, -1)).toBe('not_applicable');
  });

  it('does not divide by a target of zero', () => {
    expect(Number.isFinite(0 / 0)).toBe(false);
    expect(dataQualityBandFor(0, 0)).toBe('not_applicable');
  });
});

describe('isDataQualityBand', () => {
  it('accepts the three bands and nothing else', () => {
    for (const b of ['excellent', 'low', 'not_applicable']) {
      expect(isDataQualityBand(b)).toBe(true);
    }
    expect(isDataQualityBand('EXCELLENT')).toBe(false);
    expect(isDataQualityBand('')).toBe(false);
    expect(isDataQualityBand('poor')).toBe(false);
    // The bands that were dropped on 16 Nov must not come back by accident.
    for (const gone of ['good', 'adequate', 'below_threshold']) {
      expect(isDataQualityBand(gone)).toBe(false);
    }
  });
});

describe('isDataQualityFilter', () => {
  it('offers only the two grades, not not_applicable', () => {
    expect(isDataQualityFilter('excellent')).toBe(true);
    expect(isDataQualityFilter('low')).toBe(true);
    // A real band, but filtering a report down to the studies the coverage
    // rule cannot speak for is not a quality question.
    expect(isDataQualityFilter('not_applicable')).toBe(false);
    expect(isDataQualityFilter('good')).toBe(false);
  });
});

describe('intersectIds', () => {
  it('treats null as "everything", which is not an empty match', () => {
    expect(intersectIds(null, null)).toBeNull();
    expect(intersectIds(['a'], null)).toEqual(['a']);
    expect(intersectIds(null, ['b'])).toEqual(['b']);
  });

  it('intersects two lists', () => {
    expect(intersectIds(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['b', 'c']);
  });

  it('returns an empty list — not null — when nothing matches', () => {
    // The distinction the whole scope rests on: [] means the filter matched
    // nothing, null means there was no filter. Collapsing them would turn a
    // filter that excludes everything into no filter at all.
    expect(intersectIds(['a'], ['b'])).toEqual([]);
    expect(intersectIds(['a'], [])).toEqual([]);
  });
});

describe('the prisma where fragments', () => {
  it('are empty for an unfiltered report, so the queries are unchanged', () => {
    expect(studyWhere(UNFILTERED)).toEqual({});
    expect(needWhere(UNFILTERED)).toEqual({});
    expect(byStudyAndNeed(UNFILTERED)).toEqual({});
    expect(byNeed(UNFILTERED)).toEqual({});
    expect(byStudy(UNFILTERED)).toEqual({});
  });

  it('restrict only the dimension that is filtered', () => {
    const needsOnly: NcnpReportScope = { studyIds: null, needIds: ['n1'], active: true };
    expect(studyWhere(needsOnly)).toEqual({});
    expect(needWhere(needsOnly)).toEqual({ id: { in: ['n1'] } });
    expect(byStudyAndNeed(needsOnly)).toEqual({ needId: { in: ['n1'] } });
    expect(byNeed(needsOnly)).toEqual({ needId: { in: ['n1'] } });
    expect(byStudy(needsOnly)).toEqual({});
  });

  it('a study filter reaches the needs under those studies', () => {
    // Filtering by data quality narrows studies, and every need hangs off a
    // study. Without this the report said "0 studies" and "68 needs" at
    // once — the bug this assertion exists to keep out.
    const studiesOnly: NcnpReportScope = { studyIds: ['s1'], needIds: null, active: true };
    expect(studyWhere(studiesOnly)).toEqual({ id: { in: ['s1'] } });
    expect(needWhere(studiesOnly)).toEqual({ studyId: { in: ['s1'] } });
    expect(byStudyAndNeed(studiesOnly)).toEqual({ studyId: { in: ['s1'] } });
    // NeedDomain and friends carry no studyId, so they reach it by relation.
    expect(byNeed(studiesOnly)).toEqual({ need: { studyId: { in: ['s1'] } } });
  });

  it('applies both halves when both filters are set', () => {
    const both: NcnpReportScope = { studyIds: ['s1'], needIds: ['n1'], active: true };
    expect(needWhere(both)).toEqual({ id: { in: ['n1'] }, studyId: { in: ['s1'] } });
    expect(byNeed(both)).toEqual({ needId: { in: ['n1'] }, need: { studyId: { in: ['s1'] } } });
  });

  it('restrict both when both filters are set', () => {
    const both: NcnpReportScope = { studyIds: ['s1'], needIds: ['n1'], active: true };
    expect(byStudyAndNeed(both)).toEqual({ studyId: { in: ['s1'] }, needId: { in: ['n1'] } });
  });

  it('an empty match restricts to nothing, rather than to everything', () => {
    const nothing: NcnpReportScope = { studyIds: [], needIds: [], active: true };
    expect(studyWhere(nothing)).toEqual({ id: { in: [] } });
    expect(byStudyAndNeed(nothing)).toEqual({ studyId: { in: [] }, needId: { in: [] } });
  });
});
