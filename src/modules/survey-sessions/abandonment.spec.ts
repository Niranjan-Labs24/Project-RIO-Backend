import { describe, expect, it } from "vitest";
import {
  classifySession,
  emptyAbandonment,
  summariseAbandonment,
  stepRank,
  type SessionRow,
} from "./abandonment";

// The client answer of 24 Aug, as executable invariants:
//   1. no partial answer data — asserted here as "the summary exposes counts
//      and stages only", the shape being the guarantee;
//   2. abandonment tracked at session level — started and never completed;
//   3. abandoned/incomplete count as invalid responses (applied in RPT10, see
//      load-data-collection-completeness.ts) and drive the abandonment rate.

const NOW = new Date("2026-08-24T12:00:00.000Z");
const IDLE = 120;

function session(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    surveyId: "srv-1",
    furthestStep: "ANSWERING",
    questionCount: 10,
    answeredCount: 5,
    startedAt: new Date(NOW.getTime() - 200 * 60_000),
    lastEventAt: new Date(NOW.getTime() - 200 * 60_000),
    submittedAt: null,
    remindersSent: 0,
    ...over,
  };
}

describe("classifySession", () => {
  it("counts a submitted sitting as submitted however long ago it was", () => {
    const row = session({ submittedAt: new Date(NOW.getTime() - 10_000 * 60_000) });
    expect(classifySession(row, NOW, IDLE)).toBe("SUBMITTED");
  });

  it("counts an unsubmitted sitting as abandoned only once it is idle past the threshold", () => {
    const justInside = session({ lastEventAt: new Date(NOW.getTime() - (IDLE - 1) * 60_000) });
    const justOutside = session({ lastEventAt: new Date(NOW.getTime() - IDLE * 60_000) });
    expect(classifySession(justInside, NOW, IDLE)).toBe("IN_FLIGHT");
    expect(classifySession(justOutside, NOW, IDLE)).toBe("ABANDONED");
  });
});

describe("summariseAbandonment", () => {
  const rows = [
    session({ id: "a1-x", submittedAt: new Date(NOW.getTime() - 300 * 60_000) }),
    session({ id: "a2-x", submittedAt: new Date(NOW.getTime() - 250 * 60_000) }),
    session({ id: "b1-x", furthestStep: "ANSWERING", answeredCount: 4 }),
    session({ id: "b2-x", furthestStep: "DETAILS", answeredCount: 0 }),
    // In flight — three minutes idle.
    session({ id: "c1-x", lastEventAt: new Date(NOW.getTime() - 3 * 60_000) }),
  ];
  const summary = summariseAbandonment(rows, NOW, IDLE);

  it("splits every session into exactly one outcome", () => {
    expect(summary.sessionsStarted).toBe(5);
    expect(summary.submitted + summary.abandoned + summary.inFlight).toBe(5);
    expect(summary).toMatchObject({ submitted: 2, abandoned: 2, inFlight: 1 });
  });

  it("excludes in-flight sittings from BOTH sides of the rate", () => {
    // 2 abandoned of 4 resolved — not 2 of 5. A session still inside its idle
    // window has not failed yet, and counting it as abandoned would report
    // every survey as failing for its first two hours.
    expect(summary.resolvedSessions).toBe(4);
    expect(summary.abandonmentRatePct).toBe(50);
    expect(summary.completionRatePct).toBe(50);
  });

  it("itemises every abandoned session behind the count (AC 6)", () => {
    // A count without its rows is the silent exclusion AC 6 prohibits — the
    // same rule the flagged-records list already lives under.
    expect(summary.detail).toHaveLength(summary.abandoned);
  });

  it("reports where sittings stopped, ordered by how far they got", () => {
    expect(summary.byStage.map((s) => s.stage)).toEqual(["DETAILS", "ANSWERING"]);
    expect(summary.byStage.every((s) => s.sharePct === 50)).toBe(true);
    expect(stepRank("DETAILS")).toBeLessThan(stepRank("ANSWERING"));
  });

  it("reports progress as a COUNT of answered questions and nothing else", () => {
    // (4/10 + 0/10) / 2 = 20%. The point of the assertion is the shape as much
    // as the number: there is nowhere in this output for an answer VALUE to
    // appear, which is the client's "no partial answer data" constraint held
    // at the type level.
    expect(summary.meanProgressPct).toBe(20);
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain("answers");
  });

  it("reports zeros, not a rate, when nothing has resolved yet", () => {
    const onlyInFlight = summariseAbandonment([session({ lastEventAt: NOW })], NOW, IDLE);
    expect(onlyInFlight.resolvedSessions).toBe(0);
    // 0% here means "nothing to measure", which is why RPT10 prints the
    // tracking-coverage note beside the figure rather than the figure alone.
    expect(onlyInFlight.abandonmentRatePct).toBe(0);
  });

  it("has an empty form for a scope with no session data at all", () => {
    expect(emptyAbandonment(IDLE)).toMatchObject({
      sessionsStarted: 0,
      abandoned: 0,
      submitted: 0,
      abandonmentRatePct: 0,
      idleThresholdMinutes: IDLE,
    });
  });
});
