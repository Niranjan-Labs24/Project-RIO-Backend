import { orgContext } from "../../tenancy/org-context";
import { NeedDecisionsService } from "./need-decisions.service";

interface FakeNeed {
  id: string;
  title: string;
}
interface FakeScore {
  id: string;
  needId: string;
  surveyLinkId: string | null;
  approvedAt: Date | null;
}
interface FakeDecisionRow {
  id: string;
  needId: string;
  orgId: string;
  decisionType: string;
  responsibleParty: string;
  status: string;
  decisionDate: Date;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
interface FakeStatusEventRow {
  id: string;
  decisionId: string;
  orgId: string;
  fromStatus: string | null;
  toStatus: string;
  changedBy: string;
  changedAt: Date;
  note: string | null;
}

function fakeTenant(needs: FakeNeed[], scores: FakeScore[], decisions: FakeDecisionRow[] = []) {
  const events: FakeStatusEventRow[] = [];
  let seq = 0;
  const tx = {
    need: {
      findUnique: async ({ where }: { where: { id: string } }) => needs.find((n) => n.id === where.id) ?? null,
    },
    priorityScore: {
      findFirst: async ({ where }: { where: { needId: string; surveyLinkId: null; approvedAt: { not: null } } }) =>
        scores.find((s) => s.needId === where.needId && s.surveyLinkId === null && s.approvedAt !== null) ?? null,
    },
    needDecision: {
      create: async ({ data }: { data: Partial<FakeDecisionRow> }) => {
        const row: FakeDecisionRow = {
          id: `dec-${++seq}`,
          needId: data.needId!,
          orgId: data.orgId!,
          decisionType: data.decisionType!,
          responsibleParty: data.responsibleParty!,
          status: data.status ?? "open",
          decisionDate: data.decisionDate!,
          notes: data.notes ?? null,
          createdBy: data.createdBy!,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        decisions.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => decisions.find((d) => d.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = decisions.find((d) => d.id === where.id);
        if (!row) throw new Error("not found");
        return { ...row, statusEvents: events.filter((e) => e.decisionId === row.id) };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeDecisionRow> }) => {
        const idx = decisions.findIndex((d) => d.id === where.id);
        decisions[idx] = { ...decisions[idx], ...data } as FakeDecisionRow;
        return decisions[idx];
      },
      findMany: async ({ where }: { where: { needId: string } }) =>
        decisions
          .filter((d) => d.needId === where.needId)
          .map((d) => ({ ...d, statusEvents: events.filter((e) => e.decisionId === d.id) })),
    },
    needDecisionStatusEvent: {
      create: async ({ data }: { data: Partial<FakeStatusEventRow> }) => {
        const row: FakeStatusEventRow = {
          id: `evt-${events.length + 1}`,
          decisionId: data.decisionId!,
          orgId: data.orgId!,
          fromStatus: data.fromStatus ?? null,
          toStatus: data.toStatus!,
          changedBy: data.changedBy!,
          changedAt: new Date(),
          note: data.note ?? null,
        };
        events.push(row);
        return row;
      },
    },
  };
  return { runInOrgContext: async (fn: (tx: unknown) => unknown) => fn(tx) };
}

function fakeStudyConfig(activeDecisionTypes: string[]) {
  return { listActiveDecisionTypeNames: async () => activeDecisionTypes };
}

function fakeAudit() {
  const records: unknown[] = [];
  return { records, record: async (entry: unknown) => { records.push(entry); } };
}

function runAsOrg<T>(orgId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: "r", orgId, actorId }, fn);
}

const NEED: FakeNeed = { id: "need-1", title: "Water access gap" };

describe("NeedDecisionsService.create", () => {
  it("rejects logging a decision when the need has no priority score at all (Q34)", async () => {
    const svc = new NeedDecisionsService(
      fakeTenant([NEED], []) as never,
      fakeAudit() as never,
      fakeStudyConfig(["Intervention"]) as never,
    );
    await expect(
      runAsOrg("org-1", "user-1", () =>
        svc.create(NEED.id, { decisionType: "Intervention", responsibleParty: "Ministry of Health", decisionDate: "2026-08-22" }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: "NO_APPROVED_PRIORITY_SCORE" } } });
  });

  it("rejects logging a decision when a score exists but is not yet approved (Q34: pending counts as no score)", async () => {
    const svc = new NeedDecisionsService(
      fakeTenant([NEED], [{ id: "score-1", needId: NEED.id, surveyLinkId: null, approvedAt: null }]) as never,
      fakeAudit() as never,
      fakeStudyConfig(["Intervention"]) as never,
    );
    await expect(
      runAsOrg("org-1", "user-1", () =>
        svc.create(NEED.id, { decisionType: "Intervention", responsibleParty: "Ministry of Health", decisionDate: "2026-08-22" }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: "NO_APPROVED_PRIORITY_SCORE" } } });
  });

  it("rejects an unconfigured decision type", async () => {
    const svc = new NeedDecisionsService(
      fakeTenant([NEED], [{ id: "score-1", needId: NEED.id, surveyLinkId: null, approvedAt: new Date() }]) as never,
      fakeAudit() as never,
      fakeStudyConfig(["Intervention", "Escalation"]) as never,
    );
    await expect(
      runAsOrg("org-1", "user-1", () =>
        svc.create(NEED.id, { decisionType: "Not A Real Type", responsibleParty: "Ministry of Health", decisionDate: "2026-08-22" }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: "INVALID_DECISION_TYPE" } } });
  });

  it("creates a decision (status open) with an initial history event once the score is approved", async () => {
    const audit = fakeAudit();
    const svc = new NeedDecisionsService(
      fakeTenant([NEED], [{ id: "score-1", needId: NEED.id, surveyLinkId: null, approvedAt: new Date() }]) as never,
      audit as never,
      fakeStudyConfig(["Intervention"]) as never,
    );
    const result = await runAsOrg("org-1", "user-1", () =>
      svc.create(NEED.id, { decisionType: "Intervention", responsibleParty: "Ministry of Health", decisionDate: "2026-08-22", notes: "Urgent" }),
    );
    expect(result.status).toBe("open");
    expect(result.responsibleParty).toBe("Ministry of Health");
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({ fromStatus: null, toStatus: "open" });
    expect(audit.records).toHaveLength(1);
  });
});

describe("NeedDecisionsService.updateStatus", () => {
  async function createDecision(svc: NeedDecisionsService) {
    return runAsOrg("org-1", "user-1", () =>
      svc.create(NEED.id, { decisionType: "Intervention", responsibleParty: "Ministry of Health", decisionDate: "2026-08-22" }),
    );
  }

  it("appends a history event and updates status on a valid transition", async () => {
    const svc = new NeedDecisionsService(
      fakeTenant([NEED], [{ id: "score-1", needId: NEED.id, surveyLinkId: null, approvedAt: new Date() }]) as never,
      fakeAudit() as never,
      fakeStudyConfig(["Intervention"]) as never,
    );
    const created = await createDecision(svc);
    const updated = await runAsOrg("org-1", "user-2", () =>
      svc.updateStatus(created.id, { status: "in_progress", note: "Started coordination" }),
    );
    expect(updated.status).toBe("in_progress");
    expect(updated.history).toHaveLength(2);
    expect(updated.history[1]).toMatchObject({ fromStatus: "open", toStatus: "in_progress", note: "Started coordination" });
  });

  it("rejects moving a decision out of a terminal status (Q11: full history, no reopening completed/cancelled)", async () => {
    const svc = new NeedDecisionsService(
      fakeTenant([NEED], [{ id: "score-1", needId: NEED.id, surveyLinkId: null, approvedAt: new Date() }]) as never,
      fakeAudit() as never,
      fakeStudyConfig(["Intervention"]) as never,
    );
    const created = await createDecision(svc);
    await runAsOrg("org-1", "user-1", () => svc.updateStatus(created.id, { status: "completed" }));
    await expect(
      runAsOrg("org-1", "user-1", () => svc.updateStatus(created.id, { status: "open" })),
    ).rejects.toMatchObject({ response: { error: { code: "DECISION_ALREADY_TERMINAL" } } });
  });
});
