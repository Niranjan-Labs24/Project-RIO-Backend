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

// End-to-end walk of the multi-domain workflow's Phase 2: AI being unable
// to confidently classify a Need is now a special SUCCESS (ai_classified +
// allDomainsSelected: true, with a synthetic AiDecision recording why),
// not the old dead-end ai_classification_failed status. AiService is
// overridden to always fail, so this is deterministic — a real Gemini call
// would not be.
//
// This intentionally does NOT (yet) test narrowing the selection down via
// Override, or Question Bank generation across all domains — those are
// Phase 3 (Override becomes multi-pair) and Phase 4 (Question Bank
// matching respects allDomainsSelected) of the multi-domain plan,
// not yet built. Extend this file once those land.
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
        generateJson: async () => {
          throw new Error("forced AI failure for this test");
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

  it("lands an unclassifiable Need on ai_classified + allDomainsSelected, with a synthetic AiDecision", async () => {
    const server = app.getHttpServer();

    // 1. Researcher creates a Need — lands on pending_ai_classification,
    // then the fire-and-forget automatic classification kicks off.
    const created = await request(server)
      .post(`/api/studies/${studyId}/needs`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .send({ statement: "Multi-domain workflow e2e test — AI forced to fail." })
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

    // 3. A real AiDecision row was created (not skipped, unlike the old
    // ai_classification_failed path) — confidence 0, a rationale explaining
    // why, and no domains/subDomains suggested.
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
