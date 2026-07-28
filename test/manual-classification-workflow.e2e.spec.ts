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

// End-to-end walk of the multi-domain workflow's classification-failure
// handling. Two distinct outcomes, kept in separate describe blocks since
// each needs its own AiService mock:
//
//  - The AI genuinely runs and declines/can't decide (a vague/gibberish
//    statement) — a special SUCCESS (ai_classified + allDomainsSelected:
//    true, with a synthetic AiDecision recording why), not a dead end.
//  - The AI call itself fails for a technical reason (rate-limited, upstream
//    outage, timeout, misconfiguration) — lands on ai_classification_failed
//    with a Retry option, same as before this distinction existed. Treating
//    this the same as a decline would misrepresent a service problem as a
//    classification outcome and generate a survey off a Need the AI never
//    actually looked at.
//
// Requires: pnpm prisma:seed (uses the seeded demo org's officer user and
// an existing seeded Study).
describe("Need -> AI classification unclear -> allDomainsSelected (e2e)", () => {
  let app: INestApplication;
  let officerCookies: string[];
  let officerCsrf: string;
  let studyId: string;
  const supervisor = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }),
  });

  function csrfFrom(cookies: string[]): string {
    const csrfCookie = cookies.find((c) => c.startsWith("rio_csrf="));
    return csrfCookie?.match(/rio_csrf=([^;]*)/)?.[1] ?? "";
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AiService)
      .useValue({
        // The AI genuinely ran here — it just declined, exactly the shape
        // classification.ai.ts's classifyNeedWithAi expects for a decline
        // (classified: false, no domain/subDomain), not an exception.
        generateJson: async () => ({
          response: {
            classified: false,
            rationale: "The statement is too vague to classify into any listed domain.",
          },
        }),
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    const login = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "officer@demo-ngo.org", password: "Passw0rd!" })
      .expect(200);
    officerCookies = login.headers["set-cookie"] as unknown as string[];
    officerCsrf = csrfFrom(officerCookies);

    const admin = await supervisor.user.findFirst({ where: { email: "admin@demo-ngo.org" } });
    const study = await supervisor.study.findFirst({ where: { orgId: admin?.orgId } });
    if (!study) throw new Error("Run `pnpm prisma:seed` first (no seeded study found).");
    studyId = study.id;
  });

  afterAll(async () => {
    await app.close();
    await supervisor.$disconnect();
  });

  it("lands an unclassifiable Need on ai_classified + allDomainsSelected, with a synthetic AiDecision", async () => {
    const server = app.getHttpServer();

    // 1. Researcher creates a Need — lands on pending_ai_classification,
    // then the fire-and-forget automatic classification kicks off.
    const created = await request(server)
      .post(`/api/studies/${studyId}/needs`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .send({ statement: "Multi-domain workflow e2e test — AI declines to classify." })
      .expect(201);
    const needId = created.body.id as string;

    // Classification is fire-and-forget (not awaited by the create
    // endpoint) — poll briefly for it to land on ai_classified, same as
    // the frontend's own polling in AiClassificationSection.
    let status = created.body.status as string;
    for (let attempt = 0; attempt < 20 && status === "pending_ai_classification"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const poll = await request(server)
        .get(`/api/needs/${needId}`)
        .set("Cookie", officerCookies)
        .expect(200);
      status = poll.body.status;
    }

    // 2. No dead end — this is ai_classified, not ai_classification_failed.
    // No single domain/subDomain (nothing to freeze as the AI's prediction),
    // but allDomainsSelected is true.
    const need = await request(server)
      .get(`/api/needs/${needId}`)
      .set("Cookie", officerCookies)
      .expect(200);
    expect(need.body.status).toBe("ai_classified");
    expect(need.body.allDomainsSelected).toBe(true);
    expect(need.body.domain).toBeNull();
    expect(need.body.subDomain).toBeNull();
    expect(need.body.aiSuggestedDomain).toBeNull();
    expect(need.body.aiSuggestedSubDomain).toBeNull();

    // 3. A real AiDecision row was created (not skipped) — confidence 0, a
    // rationale explaining why, and no domains/subDomains suggested.
    const decisions = await request(server)
      .get(`/api/needs/${needId}/ai-decisions`)
      .set("Cookie", officerCookies)
      .expect(200);
    expect(decisions.body).toHaveLength(1);
    const [decision] = decisions.body;
    expect(decision.confidence).toBe(0);
    expect(decision.suggestion.domains).toEqual([]);
    expect(decision.suggestion.subDomains).toEqual([]);
    expect(typeof decision.suggestion.rationale).toBe("string");
    expect(decision.suggestion.rationale.length).toBeGreaterThan(0);

    // 4. A Survey now exists — generateSuggestedQuestions runs with an empty
    // pairs array for the allDomainsSelected case (multi-domain Phase 4),
    // matching every active, usedInMvp Question Bank entry rather than
    // filtering by a domain/subDomain this Need doesn't have.
    const survey = await request(server)
      .get(`/api/needs/${needId}/survey`)
      .set("Cookie", officerCookies)
      .expect(200);
    expect(survey.body.status).toBe("DRAFT");
    expect(Array.isArray(survey.body.questions)).toBe(true);
  }, 30_000);
});

describe("Need -> AI service failure -> ai_classification_failed + Retry (e2e)", () => {
  let app: INestApplication;
  let officerCookies: string[];
  let officerCsrf: string;
  let studyId: string;
  const supervisor = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }),
  });

  function csrfFrom(cookies: string[]): string {
    const csrfCookie = cookies.find((c) => c.startsWith("rio_csrf="));
    return csrfCookie?.match(/rio_csrf=([^;]*)/)?.[1] ?? "";
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AiService)
      .useValue({
        // Simulates a genuine technical failure (timeout, upstream outage,
        // rate limit) — the AI never actually produced a classified/
        // declined response at all.
        generateJson: async () => {
          throw new Error("simulated AI service outage for this test");
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    const login = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "officer@demo-ngo.org", password: "Passw0rd!" })
      .expect(200);
    officerCookies = login.headers["set-cookie"] as unknown as string[];
    officerCsrf = csrfFrom(officerCookies);

    const admin = await supervisor.user.findFirst({ where: { email: "admin@demo-ngo.org" } });
    const study = await supervisor.study.findFirst({ where: { orgId: admin?.orgId } });
    if (!study) throw new Error("Run `pnpm prisma:seed` first (no seeded study found).");
    studyId = study.id;
  });

  afterAll(async () => {
    await app.close();
    await supervisor.$disconnect();
  });

  it("lands the Need on ai_classification_failed with classificationError set, no AiDecision, and Retry stays available", async () => {
    const server = app.getHttpServer();

    const created = await request(server)
      .post(`/api/studies/${studyId}/needs`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .send({ statement: "Multi-domain workflow e2e test — AI service outage." })
      .expect(201);
    const needId = created.body.id as string;

    let status = created.body.status as string;
    for (let attempt = 0; attempt < 20 && status === "pending_ai_classification"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const poll = await request(server)
        .get(`/api/needs/${needId}`)
        .set("Cookie", officerCookies)
        .expect(200);
      status = poll.body.status;
    }

    // A genuine service failure is NOT the same as "AI declined" — it must
    // not be misrepresented as allDomainsSelected.
    const need = await request(server)
      .get(`/api/needs/${needId}`)
      .set("Cookie", officerCookies)
      .expect(200);
    expect(need.body.status).toBe("ai_classification_failed");
    expect(need.body.allDomainsSelected).toBe(false);
    expect(typeof need.body.classificationError).toBe("string");
    expect(need.body.classificationError.length).toBeGreaterThan(0);

    // Nothing to review — the AI never actually produced a suggestion.
    const decisions = await request(server)
      .get(`/api/needs/${needId}/ai-decisions`)
      .set("Cookie", officerCookies)
      .expect(200);
    expect(decisions.body).toHaveLength(0);

    // Retry is still offered from this status (still failing here, since
    // the mock always throws — this just confirms the endpoint stays
    // reachable and the Need stays in the same retryable state rather than
    // erroring out or getting stuck).
    await request(server)
      .post(`/api/needs/${needId}/ai-decisions/classify`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .expect(500);

    const afterRetry = await request(server)
      .get(`/api/needs/${needId}`)
      .set("Cookie", officerCookies)
      .expect(200);
    expect(afterRetry.body.status).toBe("ai_classification_failed");
  }, 30_000);
});
