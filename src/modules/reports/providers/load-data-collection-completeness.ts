import type { TenantPrismaService } from "../../../tenancy/tenant-prisma.service";
import type { SurveySessionsService } from "../../survey-sessions/survey-sessions.service";
import { summariseAbandonment, type AbandonmentSummary } from "../../survey-sessions/abandonment";

// ─────────────────────────────────────────────────────────────────────────────
// RPT10 — data-collection completeness.
//
// The client's Q14 answer put this inside the Data-Quality Report's scope:
// "(a) data-collection completeness — unanswered required questions, survey
// drop-off/abandonment rate". Their 24 Aug follow-up then settled the three
// open points on how abandonment is captured and counted:
//
//   1. A partially completed survey is NOT a data record. Formal submission
//      remains the only way a response is captured and reported. Nothing in
//      this file reads partial answer data, because none is stored.
//   2. Abandonment IS tracked, at the session/event level — that a survey was
//      started and not completed. That is what survey_sessions holds.
//   3. Abandoned/incomplete submissions count as INVALID responses, not as a
//      separate category: they contribute to the invalid-response count and
//      to the abandonment rate. That rule is applied by `invalidResponses`
//      below — and only there. See its comment for why the submission-level
//      `excluded` figure is left untouched.
//
// Everything here is a real count over real rows. A study with no session
// data yet reports zeros WITH a coverage note saying tracking was not in
// force, never a 0% abandonment rate presented as a measurement.
// ─────────────────────────────────────────────────────────────────────────────

export interface CoveredSurvey {
  surveyId: string;
  title: string;
  version: number;
  status: string;
  responses: number;
}

export interface DataCollectionScope {
  /** SURVEY when the caller named one, STUDY when the report covers the
   *  study's whole survey set. Printed on the report: RPT10 used to be
   *  labelled study-scoped while silently reporting on one resolved survey. */
  level: "SURVEY" | "STUDY";
  surveyId: string | null;
  surveysInStudy: number;
  coveredSurveys: CoveredSurvey[];
  /** Surveys in the study that these completeness figures do NOT cover — empty
   *  at study level, everything-but-one at survey level. Named, not counted,
   *  so a partial figure can never read as a total. */
  excludedSurveys: CoveredSurvey[];
  note: string;
}

export interface UnansweredRequiredQuestion {
  questionRef: string;
  questionText: string;
  domain: string;
  surveyTitle: string;
  unanswered: number;
  ofResponses: number;
  unansweredPct: number;
}

export interface UnansweredRequiredBlock {
  requiredQuestionCount: number;
  submittedResponses: number;
  /** requiredQuestionCount × the responses each question was asked of. */
  requiredAnswerSlots: number;
  unansweredCount: number;
  unansweredRatePct: number;
  /** Every required question with at least one gap — the itemisation behind
   *  `unansweredCount` (AC 6: no count without its rows). */
  byQuestion: UnansweredRequiredQuestion[];
  note: string;
}

export interface AbandonmentBlock extends AbandonmentSummary {
  /** Submitted responses in scope that have no session row at all — either
   *  collected before tracking existed, or a session write that failed (it is
   *  best-effort by design, see SurveySessionsService). Printed because it
   *  bounds how much of the rate is actually measured. */
  responsesWithoutSession: number;
  trackedResponses: number;
  submittedResponsesInScope: number;
  note: string;
}

export interface InvalidResponseBlock {
  /** Submitted responses the rollup excluded from scoring (quality screening,
   *  duplicates, unusable answers). */
  excludedSubmitted: number;
  /** Sessions started and never submitted, past the idle threshold. */
  abandonedSessions: number;
  /** The client's rule, applied: abandoned/incomplete are counted INTO the
   *  invalid-response count rather than reported as their own category. */
  total: number;
  basis: string;
}

export interface DataCollectionCompletenessBlock {
  scope: DataCollectionScope;
  abandonment: AbandonmentBlock;
  unansweredRequired: UnansweredRequiredBlock;
  invalidResponses: InvalidResponseBlock;
}

export interface CompletenessQuery {
  studyId: string;
  /** The survey the unified pipeline resolved. Present always; `explicitSurvey`
   *  is what decides whether the report is survey-scoped or study-scoped. */
  resolvedSurveyId: string;
  /** True when the caller named a survey (filters.surveyId), false when the
   *  provider had to resolve one. */
  explicitSurvey: boolean;
  /** From the rollup — submitted responses the scoring pass excluded. The
   *  rollup is the authority on this, exactly as it is everywhere else. */
  excludedSubmitted: number;
}

function pct(n: number, d: number): number {
  return d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0;
}

/** An answer key counts as answered when it holds something. "" / null /
 *  undefined / [] are the shapes the citizen page sends for "left blank", and
 *  every one of them is a gap in a REQUIRED question, not a value. */
function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export async function loadDataCollectionCompleteness(
  tenant: TenantPrismaService,
  sessions: SurveySessionsService,
  query: CompletenessQuery,
  now = new Date(),
): Promise<DataCollectionCompletenessBlock> {
  const { studyId, resolvedSurveyId, explicitSurvey } = query;

  const surveys = await tenant.runInOrgContext((tx) =>
    tx.survey.findMany({
      where: { studyId },
      orderBy: [{ createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        version: true,
        status: true,
        needId: true,
        surveyQuestions: {
          select: {
            id: true,
            isRequired: true,
            customText: true,
            domain: true,
            question: { select: { questionText: true, domain: true } },
          },
        },
      },
    }),
  );

  const inScope = explicitSurvey ? surveys.filter((s) => s.id === resolvedSurveyId) : surveys;
  const outOfScope = surveys.filter((s) => !inScope.includes(s));

  // Responses are keyed to a Need, not a Survey (see SurveyResponse) — a
  // response belongs to the survey VERSION whose question ids its answers
  // are keyed against, which is exactly the invariant submitResponse enforces
  // via SURVEY_VERSION_CHANGED. Matching on the key set is therefore the
  // faithful attribution, not a heuristic.
  const needIds = [...new Set(surveys.map((s) => s.needId))];
  const responses = needIds.length
    ? await tenant.runInOrgContext((tx) =>
        tx.surveyResponse.findMany({
          where: { studyId, needId: { in: needIds } },
          select: { id: true, needId: true, answers: true },
        }),
      )
    : [];

  const surveyOfResponse = new Map<string, string>();
  for (const response of responses) {
    const keys = Object.keys((response.answers as Record<string, unknown>) ?? {});
    const match = surveys.find(
      (s) => s.needId === response.needId && s.surveyQuestions.some((q) => keys.includes(q.id)),
    );
    // No key matches any version (an empty submission, or one whose version
    // was deleted): attributed to the need's newest survey rather than
    // dropped, so it still counts towards that survey's required-question
    // denominator instead of quietly shrinking it.
    const fallback = [...surveys].reverse().find((s) => s.needId === response.needId);
    const owner = match ?? fallback;
    if (owner) surveyOfResponse.set(response.id, owner.id);
  }

  const responsesBySurvey = new Map<string, typeof responses>();
  for (const response of responses) {
    const surveyId = surveyOfResponse.get(response.id);
    if (!surveyId) continue;
    responsesBySurvey.set(surveyId, [...(responsesBySurvey.get(surveyId) ?? []), response]);
  }

  const describe = (s: (typeof surveys)[number]): CoveredSurvey => ({
    surveyId: s.id,
    title: s.title,
    version: s.version,
    status: s.status,
    responses: responsesBySurvey.get(s.id)?.length ?? 0,
  });

  const scope: DataCollectionScope = {
    level: explicitSurvey ? "SURVEY" : "STUDY",
    surveyId: explicitSurvey ? resolvedSurveyId : null,
    surveysInStudy: surveys.length,
    coveredSurveys: inScope.map(describe),
    excludedSurveys: outOfScope.map(describe),
    note: explicitSurvey
      ? `Survey-level report. These completeness figures cover one survey of the ${surveys.length} in this study; ` +
        `the other ${outOfScope.length} are listed as out of scope and are not included in any count below.`
      : `Study-level report. These completeness figures aggregate all ${surveys.length} survey(s) in this study.`,
  };

  // ── Unanswered required questions ──
  const byQuestion: UnansweredRequiredQuestion[] = [];
  let requiredQuestionCount = 0;
  let requiredAnswerSlots = 0;
  let unansweredCount = 0;
  let submittedResponses = 0;

  for (const survey of inScope) {
    const surveyResponses = responsesBySurvey.get(survey.id) ?? [];
    submittedResponses += surveyResponses.length;
    const required = survey.surveyQuestions.filter((q) => q.isRequired);
    requiredQuestionCount += required.length;
    requiredAnswerSlots += required.length * surveyResponses.length;

    for (const question of required) {
      const missing = surveyResponses.filter(
        (r) => !isAnswered((r.answers as Record<string, unknown>)?.[question.id]),
      ).length;
      unansweredCount += missing;
      if (missing === 0) continue;
      byQuestion.push({
        questionRef: question.id.split("-")[0] ?? question.id,
        questionText: question.question?.questionText ?? question.customText ?? "(untitled question)",
        domain: question.question?.domain ?? question.domain ?? "—",
        surveyTitle: survey.title,
        unanswered: missing,
        ofResponses: surveyResponses.length,
        unansweredPct: pct(missing, surveyResponses.length),
      });
    }
  }
  byQuestion.sort((a, b) => b.unanswered - a.unanswered || a.questionText.localeCompare(b.questionText));

  const unansweredRequired: UnansweredRequiredBlock = {
    requiredQuestionCount,
    submittedResponses,
    requiredAnswerSlots,
    unansweredCount,
    unansweredRatePct: pct(unansweredCount, requiredAnswerSlots),
    byQuestion,
    note:
      requiredAnswerSlots === 0
        ? "No required questions have been asked of any submitted response in scope, so there is nothing to be unanswered."
        : `${unansweredCount} of ${requiredAnswerSlots} required answers are missing across ${submittedResponses} submitted response(s). ` +
          "A submitted response can still carry gaps: required-ness is enforced by the citizen page, not by the database, " +
          "so a response reaching the server with a blank required answer is accepted and flagged here rather than rejected silently.",
  };

  // ── Abandonment ──
  const sessionRows = await sessions.loadSessionsForReport({
    studyId,
    ...(explicitSurvey ? { surveyId: resolvedSurveyId } : {}),
  });
  const summary = summariseAbandonment(sessionRows, now, sessions.idleMinutes);
  const trackedResponses = summary.submitted;
  const responsesWithoutSession = Math.max(0, submittedResponses - trackedResponses);

  const abandonment: AbandonmentBlock = {
    ...summary,
    submittedResponsesInScope: submittedResponses,
    trackedResponses,
    responsesWithoutSession,
    note:
      summary.sessionsStarted === 0
        ? "No survey sessions were recorded in this scope. Abandonment tracking records a sitting from the moment the " +
          "survey link is opened, so responses collected before it was switched on have no session behind them — the " +
          "0% below is an absence of measurement, not a measured zero."
        : `${summary.abandoned} of ${summary.resolvedSessions} resolved session(s) were started and never submitted ` +
          `(${summary.abandonmentRatePct}%). A session counts as abandoned after ${summary.idleThresholdMinutes} minutes idle; ` +
          `${summary.inFlight} session(s) are still inside that window and are counted on neither side of the rate. ` +
          (responsesWithoutSession > 0
            ? `${responsesWithoutSession} submitted response(s) in scope have no session record and are outside this rate. `
            : "") +
          "No partial answers are stored for an abandoned session — only that it happened, where it stopped, and how many " +
          "questions had been answered.",
  };

  // ── Invalid responses, per the client's counting rule ──
  //
  // "Abandoned/incomplete submissions are counted as invalid responses, not
  // reported as a separate category."
  //
  // Applied as an ADDITIONAL total rather than by mutating the existing
  // `excluded` figure. That figure is the rollup's submitted-response
  // exclusion count, and RPT01/RPT03 reconcile against it by construction
  // (see assert-rpt01-self-consistent) — folding a session-level count into a
  // submission-level one would break that reconciliation and make two reports
  // disagree about the same word. So RPT10 prints the combined invalid total
  // the client asked for, and prints what it is made of, right beside it.
  const invalidResponses: InvalidResponseBlock = {
    excludedSubmitted: query.excludedSubmitted,
    abandonedSessions: summary.abandoned,
    total: query.excludedSubmitted + summary.abandoned,
    basis:
      `${query.excludedSubmitted} excluded submitted response(s) + ${summary.abandoned} abandoned/incomplete session(s) ` +
      "= the invalid-response count. Abandoned sittings are counted as invalid responses rather than as a separate " +
      "category, and also drive the abandonment rate above. The excluded-submitted figure on its own is the one every " +
      "other report reconciles against, which is why both are shown.",
  };

  return { scope, abandonment, unansweredRequired, invalidResponses };
}
