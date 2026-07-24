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

// Phase 3 of the multi-domain plan: the Override mechanism
// (POST .../ai-review/override-domain preview + POST .../ai-review/approve
// with domainOverride) now accepts an array of {domain, subDomain} pairs
// instead of a single pair, and committing an override fully replaces the
// Need's NeedDomain rows (and clears allDomainsSelected). AiService is
// overridden to return a deterministic single-domain classification, so the
// Need starts from a known ai_classified state before the multi-pair
// override is exercised.
//
// Requires: pnpm prisma:seed (uses the seeded demo org's officer/reviewer
// users, an existing seeded Study, and the seeded Health/Education
// Domain+Sub-domain hierarchy).
describe("Need -> multi-pair Override Domain -> Approve (e2e)", () => {
  let app: INestApplication;
  let officerCookies: string[];
  let officerCsrf: string;
  let reviewerCookies: string[];
  let reviewerCsrf: string;
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
        generateJson: async () => ({
          response: {
            classified: true,
            domain: "Health",
            subDomain: "Access to Basic Healthcare",
            confidence: 0.9,
            rationale: "Clearly a healthcare access need.",
          },
        }),
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

  it("previews without writing, then Approve-with-override fully replaces NeedDomain and clears allDomainsSelected", async () => {
    const server = app.getHttpServer();

    // 1. Researcher creates a Need — automatic classification lands it on a
    // single Health/Access-to-Basic-Healthcare pair (per the mocked AiService).
    const created = await request(server)
      .post(`/api/studies/${studyId}/needs`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .send({ statement: "Multi-domain override e2e test — clear-cut healthcare need." })
      .expect(201);
    const needId = created.body.id as string;

    let status = created.body.status as string;
    for (let attempt = 0; attempt < 20 && status === "pending_ai_classification"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const poll = await request(server).get(`/api/needs/${needId}`).set("Cookie", officerCookies).expect(200);
      status = poll.body.status;
    }

    // domain/subDomain/needDomains are the "Approved" classification — they
    // stay unset until an Approver actually reviews (see review()) — only
    // aiSuggestedDomain/aiSuggestedSubDomain are written at classification
    // time.
    const afterClassify = await request(server).get(`/api/needs/${needId}`).set("Cookie", officerCookies).expect(200);
    expect(afterClassify.body.status).toBe("ai_classified");
    expect(afterClassify.body.allDomainsSelected).toBe(false);
    expect(afterClassify.body.aiSuggestedDomain).toBe("Health");
    expect(afterClassify.body.aiSuggestedSubDomain).toBe("Access to Basic Healthcare");
    expect(afterClassify.body.needDomains).toEqual([]);

    // 2. Override-Domain preview with two candidate pairs (plus a duplicate
    // of the first, to exercise dedupe later) — must NOT write anything to
    // the Need yet.
    const previewPairs = [
      { domain: "Health", subDomain: "Access to Basic Healthcare" },
      { domain: "Education", subDomain: "Access to Basic Education" },
      { domain: "Health", subDomain: "Access to Basic Healthcare" },
    ];
    await request(server)
      .post(`/api/needs/${needId}/ai-review/override-domain`)
      .set("Cookie", reviewerCookies)
      .set("x-csrf-token", reviewerCsrf)
      .send({ pairs: previewPairs })
      .expect(201);

    const afterPreview = await request(server).get(`/api/needs/${needId}`).set("Cookie", officerCookies).expect(200);
    expect(afterPreview.body.status).toBe("ai_classified");
    expect(afterPreview.body.needDomains).toEqual([]);

    // 3. Approve with the same multi-pair (deduped) override — this is the
    // one call that actually commits: full replace of NeedDomain, Need.domain
    // /subDomain mirror the first pair, allDomainsSelected clears (it was
    // already false here, but this confirms the write path sets it explicitly).
    await request(server)
      .post(`/api/needs/${needId}/ai-review/approve`)
      .set("Cookie", reviewerCookies)
      .set("x-csrf-token", reviewerCsrf)
      .send({ domainOverride: { pairs: previewPairs, reason: "Spans both Health and Education." } })
      .expect(204);

    const afterApprove = await request(server).get(`/api/needs/${needId}`).set("Cookie", officerCookies).expect(200);
    expect(afterApprove.body.status).toBe("reviewer_approved");
    expect(afterApprove.body.allDomainsSelected).toBe(false);
    expect(afterApprove.body.domain).toBe("Health");
    expect(afterApprove.body.subDomain).toBe("Access to Basic Healthcare");
    // Deduped: the repeated Health pair collapses, leaving exactly 2 rows.
    expect(afterApprove.body.needDomains).toHaveLength(2);
    expect(afterApprove.body.needDomains).toEqual(
      expect.arrayContaining([
        { domain: "Health", subDomain: "Access to Basic Healthcare" },
        { domain: "Education", subDomain: "Access to Basic Education" },
      ]),
    );
    // aiSuggestedDomain/aiSuggestedSubDomain are the AI's own original,
    // single prediction — untouched by the Approver's override.
    expect(afterApprove.body.aiSuggestedDomain).toBe("Health");
    expect(afterApprove.body.aiSuggestedSubDomain).toBe("Access to Basic Healthcare");
  }, 30_000);
});
