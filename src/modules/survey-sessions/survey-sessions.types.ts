import type { SurveySessionStepName } from './abandonment';

export interface StartSessionResult {
  /** Opaque id the citizen page echoes back on every later call. Not a
   *  credential: it grants nothing, it only says "this is still the same
   *  sitting". Losing it costs a session row, never a submission. */
  sessionId: string;
}

export interface RecordEventPayload {
  step: SurveySessionStepName;
  /** Question index reached (0 for the non-question steps) — a position in
   *  the question set, never an answer. */
  position?: number;
  /** How many questions had a value at this moment. A COUNT: the client
   *  never sends, and the server never stores, what those values are. */
  answeredCount?: number;
}

export interface RecordEventResult {
  recorded: boolean;
}

/** What one sweep pass did — returned so the cron can log it and the spec can
 *  assert on it. */
export interface SweepResult {
  abandonedMarked: number;
  remindersSent: number;
  remindersSkipped: number;
}
