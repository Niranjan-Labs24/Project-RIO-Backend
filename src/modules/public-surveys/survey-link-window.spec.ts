import { describe, expect, it } from 'vitest';
import { resolveSurveyLinkWindow, saudiToday } from './survey-link-window';

// UAT DST-04 — survey link start/end dates.
const code = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { getResponse: () => { error: { code: string } } }).getResponse().error.code;
  }
};

describe('saudiToday', () => {
  it('uses the Saudi calendar day (UTC+3), not the UTC one', () => {
    expect(saudiToday(new Date('2026-11-03T20:59:00Z'))).toBe('2026-11-03'); // 23:59 in Riyadh
    expect(saudiToday(new Date('2026-11-03T21:00:00Z'))).toBe('2026-11-04'); // 00:00 next day in Riyadh
  });
});

describe('resolveSurveyLinkWindow', () => {
  const now = new Date('2026-11-03T09:00:00Z'); // 12:00 in Riyadh on 3 Nov

  it('opens at 00:00 Saudi time on the start date and closes at the end of the end date (end date included)', () => {
    const w = resolveSurveyLinkWindow('2026-11-10', '2026-11-20', now);
    expect(w.startsAt.toISOString()).toBe('2026-11-09T21:00:00.000Z');
    expect(w.expiresAt.toISOString()).toBe('2026-11-20T20:59:59.999Z');
    expect(w.days).toBe(11);
  });

  it('allows today as the start and a one-day window', () => {
    const w = resolveSurveyLinkWindow('2026-11-03', '2026-11-03', now);
    expect(w.days).toBe(1);
  });

  it('refuses a start date before today', () => {
    expect(code(() => resolveSurveyLinkWindow('2026-11-02', '2026-11-05', now))).toBe('SURVEY_LINK_START_IN_PAST');
  });

  it('refuses an end date before the start date', () => {
    expect(code(() => resolveSurveyLinkWindow('2026-11-10', '2026-11-09', now))).toBe('SURVEY_LINK_END_BEFORE_START');
  });

  it('allows exactly 365 days and refuses 366', () => {
    expect(resolveSurveyLinkWindow('2026-11-03', '2027-11-02', now).days).toBe(365);
    expect(code(() => resolveSurveyLinkWindow('2026-11-03', '2027-11-03', now))).toBe('SURVEY_LINK_WINDOW_TOO_LONG');
  });
});
