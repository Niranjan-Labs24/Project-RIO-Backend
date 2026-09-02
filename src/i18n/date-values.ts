import type { AppLocale } from './locale';

/**
 * Rewrites already-rendered English date text into `locale`, in place, inside
 * an otherwise-arbitrary string.
 *
 * WHY THIS EXISTS AT ALL, RATHER THAN "JUST FORMAT WITH THE LOCALE"
 *
 * Two different producers put an English date into a report and neither can be
 * handed the export locale:
 *
 *  - `report-doc.ts`'s `scalar()` folds any ISO datetime it meets into a
 *    compact stamp. It is a free function called from ~60 sites and threading a
 *    locale through all of them is a wide, risky edit for one field type.
 *  - `formatAssessmentPeriod` (reports.service.ts, coverage-counts.ts) writes
 *    "01 July 2026 - 15 July 2026" into STORED report content at generation
 *    time. By export time the source `Date` is gone; only the English string
 *    survives, and the export-time design (RIO-RPT-001) forbids regenerating
 *    the report to change its language.
 *
 * So the correction has to happen on the rendered text, at the render boundary,
 * which is exactly where `localiseReportDoc` already walks every value.
 *
 * WHY IT IS SAFE ON ARBITRARY DATA
 *
 * It only rewrites a match of `<day> <English month name> <year>`, optionally
 * followed by `, HH:MM`. The month names come from Intl itself rather than a
 * hand-written list, so they cannot drift from what the producers emit. A cell
 * that is not a date is returned by identity — this runs over village names and
 * free text and must never touch them.
 *
 * WHAT IT DELIBERATELY DOES NOT CHANGE: the calendar stays Gregorian and the
 * digits stay Western, matching `fmtStamp` in reports.placeholder.ts. Both are
 * open client questions (RIO-I18N-003 §11) and a formatter is the wrong place
 * to answer either one by accident.
 */

type MonthHit = { index: number; style: 'short' | 'long' };

/** English month name (lowercased) → its index and the style it was written
 *  in. Built from Intl so "Sept" — en-GB's four-letter short form, and the
 *  exact string that leaked into the Arabic RPT06 — is included by
 *  construction rather than by someone remembering it. */
const MONTH_INDEX: Map<string, MonthHit> = (() => {
  const map = new Map<string, MonthHit>();
  for (const style of ['short', 'long'] as const) {
    const fmt = new Intl.DateTimeFormat('en-GB', { month: style, timeZone: 'UTC' });
    for (let m = 0; m < 12; m++) {
      const name = fmt.format(new Date(Date.UTC(2026, m, 15))).toLowerCase();
      // `short` and `long` collide for May; long wins, and the two produce the
      // same output for it anyway.
      if (!map.has(name) || style === 'long') map.set(name, { index: m, style });
    }
  }
  return map;
})();

// Day, month word, year — with an optional 24-hour time, which is what
// `scalar()` appends. Anchored on word boundaries so "15 Marchmont Road" is
// not a match.
const DATE_TEXT = /\b(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})(?:,\s*(\d{1,2}):(\d{2}))?\b/g;

const OPTIONS = { calendar: 'gregory', numberingSystem: 'latn', timeZone: 'UTC' } as const;

/**
 * Every English date inside `text`, rewritten for `locale`.
 *
 * Non-`ar` locales are returned unchanged rather than reformatted: English text
 * is already in the language the English edition wants, and re-running it
 * through Intl would only risk changing a stamp the English report has always
 * shown.
 */
export function localiseDateText(text: string, locale: AppLocale): string {
  if (locale !== 'ar' || !text) return text;
  return text.replace(DATE_TEXT, (whole, day: string, month: string, year: string, hh?: string, mm?: string) => {
    const hit = MONTH_INDEX.get(month.toLowerCase());
    if (!hit) return whole;
    const dayNum = Number(day);
    const yearNum = Number(year);
    // A day outside 1-31 means the regex matched something that is not a date
    // (a page range, a measurement). Leave it exactly as it was.
    if (dayNum < 1 || dayNum > 31) return whole;

    const d = new Date(Date.UTC(yearNum, hit.index, dayNum, hh ? Number(hh) : 0, mm ? Number(mm) : 0));
    if (Number.isNaN(d.getTime())) return whole;

    // Rebuilt in the SAME shape it was found in — a short month stays short —
    // so the Arabic edition's dates line up column-for-column with the English
    // one rather than suddenly needing more width.
    const base: Intl.DateTimeFormatOptions = {
      ...OPTIONS,
      day: day.length === 2 ? '2-digit' : 'numeric',
      month: hit.style,
      year: 'numeric',
    };
    if (hh === undefined) return new Intl.DateTimeFormat(locale, base).format(d);
    return new Intl.DateTimeFormat(locale, {
      ...base,
      hour: '2-digit',
      minute: '2-digit',
      // 24-hour in both languages. Arabic's default is 12-hour with ص/م, which
      // would make one instant read as "04:00 م" in one edition and "16:00" in
      // the other — two files under one approval showing different-looking
      // timestamps is the reconciliation problem export-time localisation
      // exists to prevent. Same pin as `fmtStamp`.
      hourCycle: 'h23',
    }).format(d);
  });
}
