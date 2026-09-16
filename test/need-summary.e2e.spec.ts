import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { pgSslFromEnv } from "../src/prisma/pg-ssl";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/http-exception.filter";
import { AiService } from "../src/modules/ai/ai.service";

/**
 * RIO-AI-003 end to end: a long need statement is summarised automatically, the
 * reviewer edits and confirms it, and only then does it reach a report.
 *
 * What this file adds over need-summary.service.spec.ts (which fakes the
 * database) is the wiring the unit tests cannot see:
 *
 *   - the auto-trigger actually firing off NeedsService.create;
 *   - the permission split — every write is aiReview:approve, so the Research
 *     Officer who wrote the need can read the summary but cannot edit or
 *     confirm it (AC 2 and AC 3 both name the reviewer, and human_reviewer is
 *     the role that holds `approve`);
 *   - RLS: a second org cannot read the first org's summaries.
 *
 * AiService is mocked so the run is deterministic and costs nothing. The
 * classification task and the summary task share the mock, so it branches on
 * which task it was handed.
 *
 * Requires: pnpm prisma:seed, and a database with the
 * 20260825090000_need_statement_summaries migration applied.
 */
describe("Need statement summarisation (e2e)", () => {
  let app: INestApplication;
  let officerCookies: string[];
  let officerCsrf: string;
  let reviewerCookies: string[];
  let reviewerCsrf: string;
  let studyId: string;
  const supervisor = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.SUPERVISOR_DATABASE_URL,
      ssl: pgSslFromEnv(),
    }),
  });

  // Long enough to clear the 1,500-character default threshold, and carrying a
  // place name and an affected group so the verification checks have something
  // real to assert on.
  // Note the parentheses: `a + b + c.repeat(n)` would repeat only `c`, which
  // lands at ~1,000 characters — under the 1,500 threshold, so nothing would
  // ever be summarised and every assertion here would fail for the wrong
  // reason.
  const LONG_STATEMENT = (
    "Households in Al-Jumum North report that the piped water supply reaches the village only two days per week. " +
    "Women and children collect water from a private tanker point on the remaining days. " +
    "Residents say the situation has continued since the last dry season. "
  ).repeat(10);

  const SUMMARY_TEXT =
    "Piped water in Al-Jumum North reaches the village two days per week; women and children collect from a private tanker point otherwise.";

  // Each test creates one or two Needs, and every Need creation kicks off
  // classification AND summarisation as fire-and-forget work this spec then
  // polls for. That does not fit vitest's 5s default, so every test below
  // names this explicitly rather than raising the global timeout and slowing
  // the failure signal for every other spec in the repo.
  const TEST_TIMEOUT_MS = 40_000;

  function csrfFrom(cookies: string[]): string {
    return cookies.find((c) => c.startsWith("rio_csrf="))?.match(/rio_csrf=([^;]*)/)?.[1] ?? "";
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AiService)
      .useValue({
        run: async (task: { name: string }) => {
          if (task.name === "need-statement-summary") {
            return {
              response: {
                summary: SUMMARY_TEXT,
                preservedFacts: ["Al-Jumum North", "Women and children"],
                omittedForLength: false,
              },
            };
          }
          return {
            response: {
              classified: true,
              domain: "Health",
              subDomain: "Access to Basic Healthcare",
              confidence: 0.9,
              rationale: "Deterministic stub for the summarisation e2e.",
            },
          };
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    const officerLogin = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "officer@demo-ngo.org", password: "Passw0rd!" })
      .expect(200);
    officerCookies = officerLogin.headers["set-cookie"] as unknown as string[];
    officerCsrf = csrfFrom(officerCookies);

    const reviewerLogin = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "reviewer@demo-ngo.org", password: "Passw0rd!" })
      .expect(200);
    reviewerCookies = reviewerLogin.headers["set-cookie"] as unknown as string[];
    reviewerCsrf = csrfFrom(reviewerCookies);

    const admin = await supervisor.user.findFirst({ where: { email: "admin@demo-ngo.org" } });
    const study = await supervisor.study.findFirst({ where: { orgId: admin?.orgId } });
    if (!study) throw new Error("Run `pnpm prisma:seed` first (no seeded study found).");
    studyId = study.id;
  });

  afterAll(async () => {
    await app.close();
    await supervisor.$disconnect();
  });

  /** The summary is generated fire-and-forget, so poll rather than assume. */
  async function waitForSummary(needId: string, cookies: string[]) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const res = await request(app.getHttpServer())
        .get(`/api/needs/${needId}/summary`)
        .set("Cookie", cookies);
      if (res.status === 200 && res.body?.id) return res.body;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`No summary appeared for need ${needId} within the poll window.`);
  }

  async function createNeed(statement: string): Promise<string> {
    const created = await request(app.getHttpServer())
      .post(`/api/studies/${studyId}/needs`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .send({ statement })
      .expect(201);
    return created.body.id as string;
  }

  it("the fixture actually clears the configured threshold", () => {
    // Guards the whole file: every assertion below assumes this statement is
    // long enough to trigger summarisation at the shipped default of 1,500.
    expect(LONG_STATEMENT.length).toBeGreaterThan(1500);
    expect(LONG_STATEMENT.length).toBeLessThanOrEqual(5000);
  });

  it("AC 1 — a long statement is summarised automatically, a short one is not", async () => {
    const longNeedId = await createNeed(LONG_STATEMENT);
    const summary = await waitForSummary(longNeedId, officerCookies);

    expect(summary).not.toBeNull();
    expect(summary.status).toBe("DRAFT");
    expect(summary.aiSummaryText).toBe(SUMMARY_TEXT);
    expect(summary.triggerSource).toBe("manual_entry");

    // The same endpoint returns null for a statement below the threshold —
    // nobody had to ask for a summary, and none was produced.
    const shortNeedId = await createNeed("Short statement, well under the threshold.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const none = await request(app.getHttpServer())
      .get(`/api/needs/${shortNeedId}/summary`)
      .set("Cookie", officerCookies)
      .expect(200);
    // The service returns null, which Nest sends as an empty body — supertest
    // surfaces that as `{}`, not as null, so assert on the absence of a
    // summary rather than on falsiness of the body object.
    expect(none.text).toBe("");
    expect(none.body?.id).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  it("AC 4 — the original statement comes back alongside the summary", async () => {
    const needId = await createNeed(LONG_STATEMENT);
    const summary = await waitForSummary(needId, officerCookies);

    expect(summary.sourceStatement).toBe(LONG_STATEMENT);
    expect(summary.sourceLength).toBe(LONG_STATEMENT.length);
    // And the Need itself still carries the full text — the summary is
    // additive, it never replaced anything.
    const need = await request(app.getHttpServer())
      .get(`/api/needs/${needId}`)
      .set("Cookie", officerCookies)
      .expect(200);
    expect(need.body.statement).toBe(LONG_STATEMENT);
  }, TEST_TIMEOUT_MS);

  it("AC 2 + AC 3 — the reviewer edits and confirms; the officer can do neither", async () => {
    const needId = await createNeed(LONG_STATEMENT);
    const summary = await waitForSummary(needId, officerCookies);

    // The officer who wrote the need holds aiReview:read, so they can SEE the
    // suggestion and the original beside it...
    await request(app.getHttpServer())
      .get(`/api/needs/${needId}/summary`)
      .set("Cookie", officerCookies)
      .expect(200);

    // ...but not edit it. Both criteria name the reviewer, and `write` here
    // would have handed the edit to the two roles the ticket never mentions.
    await request(app.getHttpServer())
      .patch(`/api/need-summaries/${summary.id}`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .send({ summaryText: "Officer should not be able to write this." })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/need-summaries/${summary.id}/confirm`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .expect(403);

    // The reviewer can do both.
    const edited = await request(app.getHttpServer())
      .patch(`/api/need-summaries/${summary.id}`)
      .set("Cookie", reviewerCookies)
      .set("x-csrf-token", reviewerCsrf)
      .send({ summaryText: "Reviewer's tightened wording." })
      .expect(200);
    expect(edited.body.reviewerEditedText).toBe("Reviewer's tightened wording.");
    // The model's original survives the edit — that is the AC's "both stored".
    expect(edited.body.aiSummaryText).toBe(SUMMARY_TEXT);

    const confirmed = await request(app.getHttpServer())
      .post(`/api/need-summaries/${summary.id}/confirm`)
      .set("Cookie", reviewerCookies)
      .set("x-csrf-token", reviewerCsrf)
      .expect(201);
    expect(confirmed.body.status).toBe("CONFIRMED");
    expect(confirmed.body.confirmedAt).toBeTruthy();
    expect(confirmed.body.effectiveText).toBe("Reviewer's tightened wording.");
  }, TEST_TIMEOUT_MS);

  it("a confirmed summary can no longer be edited or re-confirmed", async () => {
    const needId = await createNeed(LONG_STATEMENT);
    const summary = await waitForSummary(needId, officerCookies);

    await request(app.getHttpServer())
      .post(`/api/need-summaries/${summary.id}/confirm`)
      .set("Cookie", reviewerCookies)
      .set("x-csrf-token", reviewerCsrf)
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/need-summaries/${summary.id}`)
      .set("Cookie", reviewerCookies)
      .set("x-csrf-token", reviewerCsrf)
      .send({ summaryText: "Too late." })
      .expect(400);

    await request(app.getHttpServer())
      .post(`/api/need-summaries/${summary.id}/confirm`)
      .set("Cookie", reviewerCookies)
      .set("x-csrf-token", reviewerCsrf)
      .expect(400);
  }, TEST_TIMEOUT_MS);

  it("the reviewer queue lists drafts and bulk-confirms them", async () => {
    const a = await createNeed(LONG_STATEMENT);
    const b = await createNeed(LONG_STATEMENT + " Second need for the batch.");
    const sa = await waitForSummary(a, officerCookies);
    const sb = await waitForSummary(b, officerCookies);

    const queue = await request(app.getHttpServer())
      .get("/api/need-summaries/pending")
      .set("Cookie", reviewerCookies)
      .expect(200);
    const queuedIds = (queue.body.items as { id: string }[]).map((i) => i.id);
    expect(queuedIds).toEqual(expect.arrayContaining([sa.id, sb.id]));

    const batch = await request(app.getHttpServer())
      .post("/api/need-summaries/confirm-batch")
      .set("Cookie", reviewerCookies)
      .set("x-csrf-token", reviewerCsrf)
      .send({ summaryIds: [sa.id, sb.id] })
      .expect(201);
    expect(batch.body.confirmed).toEqual(expect.arrayContaining([sa.id, sb.id]));
    expect(batch.body.skipped).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("editing the statement marks a confirmed summary stale rather than deleting it", async () => {
    const needId = await createNeed(LONG_STATEMENT);
    const summary = await waitForSummary(needId, officerCookies);
    await request(app.getHttpServer())
      .post(`/api/need-summaries/${summary.id}/confirm`)
      .set("Cookie", reviewerCookies)
      .set("x-csrf-token", reviewerCsrf)
      .expect(201);

    // A Need is only editable pre-approval; rejecting the classification puts
    // it back into that window.
    await request(app.getHttpServer())
      .post(`/api/needs/${needId}/ai-review/reject`)
      .set("Cookie", reviewerCookies)
      .set("x-csrf-token", reviewerCsrf)
      .send({ comments: "Editing the statement for the staleness check." })
      .expect(204);

    await request(app.getHttpServer())
      .patch(`/api/needs/${needId}`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .send({ statement: LONG_STATEMENT + " Newly appended detail." })
      .expect(200);

    // The decision itself is preserved for audit — the row is still there.
    const rows = await supervisor.needStatementSummary.findMany({ where: { needId } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.status === "STALE" || r.status === "SUPERSEDED")).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("RLS — a second organisation cannot read this org's summaries", async () => {
    const needId = await createNeed(LONG_STATEMENT);
    const summary = await waitForSummary(needId, officerCookies);

    const otherLogin = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "admin@riverside-ngo.org", password: "Passw0rd!" })
      .expect(200);
    const otherCookies = otherLogin.headers["set-cookie"] as unknown as string[];

    const res = await request(app.getHttpServer())
      .get(`/api/needs/${needId}/summary`)
      .set("Cookie", otherCookies);
    // Either the guard refuses the module or RLS returns nothing — both are
    // correct, and neither may leak the other org's summary text.
    expect(res.body?.id).not.toBe(summary.id);
    expect(JSON.stringify(res.body ?? {})).not.toContain(SUMMARY_TEXT);
  }, TEST_TIMEOUT_MS);
});
