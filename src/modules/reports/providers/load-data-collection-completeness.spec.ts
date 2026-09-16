import { describe, expect, it } from "vitest";
import { loadDataCollectionCompleteness } from "./load-data-collection-completeness";
import type { SessionRow } from "../../survey-sessions/abandonment";

// RPT10 data-collection completeness — the client's Q14 answer (a) plus the
// 24 Aug follow-up. These assert the two pieces of real logic in the loader:
// which responses belong to which survey version (and therefore which
// required-question gaps are real), and the invalid-response counting rule.

const NOW = new Date("2026-08-24T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const SURVEYS = [
  {
    id: "srv-1",
    title: "Baseline Survey",
    version: 1,
    status: "SUPERSEDED",
    needId: "need-1",
    surveyQuestions: [
      { id: "q-old-1", isRequired: true, customText: null, domain: null, question: { questionText: "Water access?", domain: "Water" } },
    ],
  },
  {
    id: "srv-2",
    title: "Baseline Survey",
    version: 2,
    status: "PUBLISHED",
    needId: "need-1",
    surveyQuestions: [
      { id: "q-1", isRequired: true, customText: null, domain: null, question: { questionText: "Water access?", domain: "Water" } },
      { id: "q-2", isRequired: true, customText: "How many households?", domain: "Water", question: null },
      { id: "q-3", isRequired: false, customText: "Anything else?", domain: "Water", question: null },
    ],
  },
];

const RESPONSES = [
  // Complete against v2.
  { id: "r-1", needId: "need-1", answers: { "q-1": "Yes", "q-2": "12", "q-3": "" } },
  // Required q-2 left blank — a submitted response can still carry a gap,
  // because required-ness is enforced by the citizen page, not the database.
  { id: "r-2", needId: "need-1", answers: { "q-1": "No", "q-2": "   " } },
  // Answered against the SUPERSEDED version — must count towards v1, not v2,
  // or v2's gap rate is diluted by responses that were never asked its
  // questions.
  { id: "r-3", needId: "need-1", answers: { "q-old-1": "Yes" } },
];

function fakeTenant(surveys = SURVEYS, responses = RESPONSES) {
  return {
    runInOrgContext: <T,>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        survey: { findMany: async () => surveys },
        surveyResponse: { findMany: async () => responses },
      }),
  } as never;
}

function fakeSessions(rows: SessionRow[], idleMinutes = 120) {
  return { idleMinutes, loadSessionsForReport: async () => rows } as never;
}

const abandonedRow: SessionRow = {
  id: "bbbbbbbb-1111-2222-3333-444444444444",
  surveyId: "srv-2",
  furthestStep: "ANSWERING",
  questionCount: 3,
  answeredCount: 1,
  startedAt: minutesAgo(400),
  lastEventAt: minutesAgo(390),
  submittedAt: null,
  remindersSent: 1,
};

describe("loadDataCollectionCompleteness", () => {
  it("attributes each response to the survey version its answers were keyed against", async () => {
    const block = await loadDataCollectionCompleteness(
      fakeTenant(),
      fakeSessions([]),
      { studyId: "study-1", resolvedSurveyId: "srv-2", explicitSurvey: false, excludedSubmitted: 0 },
      NOW,
    );
    const byId = new Map(block.scope.coveredSurveys.map((s) => [s.surveyId, s.responses]));
    expect(byId.get("srv-1")).toBe(1);
    expect(byId.get("srv-2")).toBe(2);
  });

  it("counts a blank or whitespace-only required answer as unanswered", async () => {
    const block = await loadDataCollectionCompleteness(
      fakeTenant(),
      fakeSessions([]),
      { studyId: "study-1", resolvedSurveyId: "srv-2", explicitSurvey: false, excludedSubmitted: 0 },
      NOW,
    );
    // v2: q-1 and q-2 required × 2 responses = 4 slots, of which q-2 on r-2 is
    // whitespace. v1: q-old-1 required × 1 response = 1 slot, answered.
    expect(block.unansweredRequired.requiredAnswerSlots).toBe(5);
    expect(block.unansweredRequired.unansweredCount).toBe(1);
    // The optional question is not counted at all — an unanswered optional is
    // not a gap.
    expect(block.unansweredRequired.byQuestion).toHaveLength(1);
    expect(block.unansweredRequired.byQuestion[0]).toMatchObject({
      questionText: "How many households?",
      unanswered: 1,
      ofResponses: 2,
    });
  });

  it("counts abandoned sessions INTO the invalid-response total, leaving the reconciled figure alone", async () => {
    const block = await loadDataCollectionCompleteness(
      fakeTenant(),
      fakeSessions([abandonedRow]),
      { studyId: "study-1", resolvedSurveyId: "srv-2", explicitSurvey: false, excludedSubmitted: 2 },
      NOW,
    );
    expect(block.abandonment.abandoned).toBe(1);
    // The client rule: abandoned/incomplete are invalid responses, not their
    // own category.
    expect(block.invalidResponses).toMatchObject({
      excludedSubmitted: 2,
      abandonedSessions: 1,
      total: 3,
    });
    // …and the rollup's own figure is untouched, because RPT01/RPT03
    // reconcile against it.
    expect(block.invalidResponses.excludedSubmitted).toBe(2);
  });

  it("says the abandonment rate is unmeasured when no sessions were tracked", async () => {
    const block = await loadDataCollectionCompleteness(
      fakeTenant(),
      fakeSessions([]),
      { studyId: "study-1", resolvedSurveyId: "srv-2", explicitSurvey: false, excludedSubmitted: 0 },
      NOW,
    );
    expect(block.abandonment.sessionsStarted).toBe(0);
    expect(block.abandonment.abandonmentRatePct).toBe(0);
    // A 0% that means "nothing was measured" must never be printed as though
    // it means "nobody dropped out".
    expect(block.abandonment.note).toContain("absence of measurement");
    expect(block.abandonment.responsesWithoutSession).toBe(3);
  });

  it("names the surveys a survey-scoped report does NOT cover", async () => {
    const block = await loadDataCollectionCompleteness(
      fakeTenant(),
      fakeSessions([]),
      { studyId: "study-1", resolvedSurveyId: "srv-2", explicitSurvey: true, excludedSubmitted: 0 },
      NOW,
    );
    expect(block.scope.level).toBe("SURVEY");
    expect(block.scope.coveredSurveys.map((s) => s.surveyId)).toEqual(["srv-2"]);
    // The defect this replaces: a study-level label over single-survey figures.
    expect(block.scope.excludedSurveys.map((s) => s.surveyId)).toEqual(["srv-1"]);
    expect(block.unansweredRequired.requiredAnswerSlots).toBe(4);
  });
});
