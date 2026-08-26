// Abandonment classification and summary — pure, so the sweep that PERSISTS
// the classification and the report that DERIVES it live can never disagree.
// Both call the functions here; neither has its own copy of the rule.
//
// Client answer, 24 Aug (RPT10 Q-2):
//   • track that a survey was started and not completed, at session/event
//     level, not by retaining partial answer data;
//   • count abandoned/incomplete as INVALID responses rather than as a
//     separate category, contributing to both the invalid-response count and
//     the abandonment rate in the Data-Quality Report.
// The second point is applied where the report is assembled (see
// load-data-collection-completeness.ts); this file only decides which
// sessions are abandoned and where they stopped.

export type SurveySessionStepName =
  | "OPENED"
  | "DETAILS"
  | "OTP_REQUESTED"
  | "OTP_VERIFIED"
  | "ANSWERING"
  | "REVIEW"
  | "SUBMITTED";

/** Ordered — a session's furthest step only ever moves forwards. */
export const SESSION_STEPS: SurveySessionStepName[] = [
  "OPENED",
  "DETAILS",
  "OTP_REQUESTED",
  "OTP_VERIFIED",
  "ANSWERING",
  "REVIEW",
  "SUBMITTED",
];

const STEP_LABELS: Record<SurveySessionStepName, string> = {
  OPENED: "Opened the link",
  DETAILS: "Entered contact details",
  OTP_REQUESTED: "Requested a verification code",
  OTP_VERIFIED: "Verified — started answering",
  ANSWERING: "Answering questions",
  REVIEW: "Reached the review step",
  SUBMITTED: "Submitted",
};

export function stepLabel(step: SurveySessionStepName): string {
  return STEP_LABELS[step] ?? step;
}

export function stepRank(step: SurveySessionStepName): number {
  const i = SESSION_STEPS.indexOf(step);
  return i === -1 ? 0 : i;
}

export interface SessionRow {
  id: string;
  surveyId: string | null;
  furthestStep: SurveySessionStepName;
  questionCount: number;
  answeredCount: number;
  startedAt: Date;
  lastEventAt: Date;
  submittedAt: Date | null;
  remindersSent: number;
}

/** SUBMITTED and ABANDONED are terminal; IN_FLIGHT is a session that is still
 *  inside its idle window and may yet submit. In-flight sessions are excluded
 *  from BOTH sides of the abandonment rate — counting them as abandoned would
 *  report every survey as failing for the first two hours of its life. */
export type SessionOutcome = "SUBMITTED" | "ABANDONED" | "IN_FLIGHT";

export function classifySession(row: SessionRow, now: Date, idleMinutes: number): SessionOutcome {
  if (row.submittedAt) return "SUBMITTED";
  const idleMs = now.getTime() - row.lastEventAt.getTime();
  return idleMs >= idleMinutes * 60_000 ? "ABANDONED" : "IN_FLIGHT";
}

export interface AbandonedSessionDetail {
  /** First segment of the uuid. A session is not a person and carries no
   *  answers, but it is still respondent-linked metadata — a report reader
   *  needs to count and stage these, never to identify who they were. */
  sessionRef: string;
  stage: SurveySessionStepName;
  stageLabel: string;
  progress: string;
  startedAt: string;
  lastActivityAt: string;
  remindersSent: number;
}

export interface AbandonmentSummary {
  /** Every session opened in scope, whatever its outcome. */
  sessionsStarted: number;
  submitted: number;
  abandoned: number;
  inFlight: number;
  /** abandoned / (abandoned + submitted), as a percentage to 1dp. In-flight
   *  sessions are in neither term — see SessionOutcome. 0 when nothing has
   *  resolved yet, which the narrative states rather than implying a 0% rate
   *  was measured. */
  abandonmentRatePct: number;
  completionRatePct: number;
  resolvedSessions: number;
  idleThresholdMinutes: number;
  /** Where abandoned sessions stopped — the "why" behind the rate. */
  byStage: Array<{ stage: SurveySessionStepName; stageLabel: string; count: number; sharePct: number }>;
  /** Mean answered/total across abandoned sessions that had reached the
   *  question set at all. Null when none did. A count of answered questions,
   *  never their content. */
  meanProgressPct: number | null;
  /** AC-6: the itemised rows behind `abandoned`. A count without its rows is
   *  the silent exclusion the criterion prohibits. */
  detail: AbandonedSessionDetail[];
  remindersSent: number;
}

function pct(n: number, d: number): number {
  return d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0;
}

export function summariseAbandonment(
  rows: SessionRow[],
  now: Date,
  idleMinutes: number,
): AbandonmentSummary {
  let submitted = 0;
  let inFlight = 0;
  const abandonedRows: SessionRow[] = [];

  for (const row of rows) {
    const outcome = classifySession(row, now, idleMinutes);
    if (outcome === "SUBMITTED") submitted += 1;
    else if (outcome === "IN_FLIGHT") inFlight += 1;
    else abandonedRows.push(row);
  }

  const abandoned = abandonedRows.length;
  const resolved = abandoned + submitted;

  const stageCounts = new Map<SurveySessionStepName, number>();
  for (const row of abandonedRows) {
    stageCounts.set(row.furthestStep, (stageCounts.get(row.furthestStep) ?? 0) + 1);
  }
  const byStage = [...stageCounts.entries()]
    .sort((a, b) => stepRank(a[0]) - stepRank(b[0]))
    .map(([stage, count]) => ({
      stage,
      stageLabel: stepLabel(stage),
      count,
      sharePct: pct(count, abandoned),
    }));

  const withQuestions = abandonedRows.filter((r) => r.questionCount > 0);
  const meanProgressPct = withQuestions.length
    ? Number(
        (
          withQuestions.reduce((sum, r) => sum + (r.answeredCount / r.questionCount) * 100, 0) /
          withQuestions.length
        ).toFixed(1),
      )
    : null;

  return {
    sessionsStarted: rows.length,
    submitted,
    abandoned,
    inFlight,
    abandonmentRatePct: pct(abandoned, resolved),
    completionRatePct: pct(submitted, resolved),
    resolvedSessions: resolved,
    idleThresholdMinutes: idleMinutes,
    byStage,
    meanProgressPct,
    detail: abandonedRows
      .slice()
      .sort((a, b) => b.lastEventAt.getTime() - a.lastEventAt.getTime())
      .map((r) => ({
        sessionRef: r.id.split("-")[0] ?? r.id,
        stage: r.furthestStep,
        stageLabel: stepLabel(r.furthestStep),
        progress: r.questionCount > 0 ? `${r.answeredCount} of ${r.questionCount} answered` : "—",
        startedAt: r.startedAt.toISOString(),
        lastActivityAt: r.lastEventAt.toISOString(),
        remindersSent: r.remindersSent,
      })),
    remindersSent: rows.reduce((sum, r) => sum + r.remindersSent, 0),
  };
}

/** The empty-scope summary — a study whose surveys have collected nothing yet,
 *  or one whose responses all predate session tracking. Distinct from "0%
 *  abandonment measured", which is why RPT10 prints a tracking-coverage note
 *  beside the rate (see load-data-collection-completeness.ts). */
export function emptyAbandonment(idleMinutes: number): AbandonmentSummary {
  return summariseAbandonment([], new Date(0), idleMinutes);
}
