import { BadRequestException } from '@nestjs/common';

// UAT DST-04 — a survey link's active window, entered as two calendar dates.
//
// Dates are calendar days in Saudi time (Asia/Riyadh, UTC+3, no daylight
// saving), the time zone every respondent and NCNP user works in: the link
// opens at 00:00 on the start date and stays open to the end of the end date
// (the end date itself is included).

const SAUDI_UTC_OFFSET = '+03:00';
const SAUDI_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_SURVEY_LINK_WINDOW_DAYS = 365;

export interface SurveyLinkWindow {
  startsAt: Date;
  expiresAt: Date;
  /** Calendar days in the window, both ends included. */
  days: number;
}

/** Today's date (YYYY-MM-DD) in Saudi time. */
export function saudiToday(now: Date = new Date()): string {
  return new Date(now.getTime() + SAUDI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Validates and converts the start/end dates of a new survey link.
 * The contract has already checked both are real YYYY-MM-DD dates.
 */
export function resolveSurveyLinkWindow(startDate: string, endDate: string, now: Date = new Date()): SurveyLinkWindow {
  const fail = (code: string, message: string): never => {
    throw new BadRequestException({ error: { code, message } });
  };
  if (startDate < saudiToday(now)) {
    fail('SURVEY_LINK_START_IN_PAST', 'The start date cannot be in the past.');
  }
  if (endDate < startDate) {
    fail('SURVEY_LINK_END_BEFORE_START', 'The end date must be on or after the start date.');
  }
  const startsAt = new Date(`${startDate}T00:00:00.000${SAUDI_UTC_OFFSET}`);
  const expiresAt = new Date(`${endDate}T23:59:59.999${SAUDI_UTC_OFFSET}`);
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > MAX_SURVEY_LINK_WINDOW_DAYS) {
    fail('SURVEY_LINK_WINDOW_TOO_LONG', `A survey link can be open for at most ${MAX_SURVEY_LINK_WINDOW_DAYS} days.`);
  }
  return { startsAt, expiresAt, days };
}
