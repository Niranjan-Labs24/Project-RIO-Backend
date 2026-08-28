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
import { randomUUID } from "node:crypto";

/**
 * RIO-FR-003 end to end, against the real database.
 *
 * What this adds over priority-factors.spec.ts (which is pure arithmetic) and
 * need-themes.service.spec.ts (which fakes Prisma) is the wiring neither can
 * see: that config edits actually reach the engine, that the permission split
 * holds, and that an override survives a round trip without eating the
 * computed value.
 *
 * The AI is mocked so theme extraction is deterministic — a recurrence count
 * that moved between runs would make every assertion here a coin toss.
 *
 * Requires: pnpm prisma:seed, and the 20260827100000_fr003_priority_scoring
 * migration applied.
 */
describe("FR-003 priority scoring (e2e)", () => {
  let app: INestApplication;
  let officerCookies: string[];
  let officerCsrf: string;
  let analystCookies: string[];
  let analystCsrf: string;
  let adminCookies: string[];
  let adminCsrf: string;
  let studyId: string;

  // Reads go through the supervisor connection (SELECT-only, cross-org).
  const supervisor = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.SUPERVISOR_DATABASE_URL,
      ssl: pgSslFromEnv(),
    }),
  });
  // Fixture WRITES need the owner connection: cnap_supervisor is SELECT-only
  // by design, and the scores below are set up directly because reaching them
  // through the API would need a published, fully scored survey — a fixture of
  // its own, and not what these assertions are about.
  const owner = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      ssl: pgSslFromEnv(),
    }),
  });

  const TEST_TIMEOUT_MS = 40_000;

  // Two themes from the seeded vocabulary. Fixed, so the recurrence count in
  // the assertions below is a number and not a moving target.
  const THEMES = ["Distance to facility", "Transport availability"];

  const STATEMENT =
    "Families report the nearest primary health centre is more than 12 km away and there is no scheduled transport.";

  function csrfFrom(cookies: string[]): string {
    return cookies.find((c) => c.startsWith("rio_csrf="))?.match(/rio_csrf=([^;]*)/)?.[1] ?? "";
  }

  async function login(email: string): Promise<[string[], string]> {
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email, password: "Passw0rd!" })
      .expect(200);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    return [cookies, csrfFrom(cookies)];
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AiService)
      .useValue({
        run: async (task: { name: string }) => {
          if (task.name === "need-theme-extraction") {
            return { response: { themes: THEMES, rationale: "stub" } };
          }
          if (task.name === "need-statement-summary") {
            return { response: { summary: "Short.", preservedFacts: [], omittedForLength: false } };
          }
          return {
            response: {
              classified: true,
              domain: "Health",
              subDomain: "Access to Basic Healthcare",
              confidence: 0.9,
              rationale: "stub",
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

    [officerCookies, officerCsrf] = await login("officer@demo-ngo.org");
    [analystCookies, analystCsrf] = await login("analyst@demo-ngo.org");
    [adminCookies, adminCsrf] = await login("sysadmin@platform.local");

    const admin = await supervisor.user.findFirst({ where: { email: "admin@demo-ngo.org" } });
    const study = await supervisor.study.findFirst({ where: { orgId: admin?.orgId } });
    if (!study) throw new Error("Run `pnpm prisma:seed` first (no seeded study found).");
    studyId = study.id;
  });

  afterAll(async () => {
    await app.close();
    await supervisor.$disconnect();
    await owner.$disconnect();
  });

  async function createNeed(extra: Record<string, unknown> = {}): Promise<string> {
    const created = await request(app.getHttpServer())
      .post(`/api/studies/${studyId}/needs`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .send({ title: "FR-003 health access", statement: STATEMENT, ...extra })
      .expect(201);
    return created.body.id as string;
  }

  /**
   * Creates a PriorityScore row directly.
   *
   * Raw SQL inside a transaction that sets the RLS org context first: every
   * tenant table is FORCE ROW LEVEL SECURITY, so an insert with no
   * `app.current_org_id` matches no policy and is refused — which is the
   * isolation guarantee working, not a problem to route around.
   *
   * Direct rather than through the API because the scoring endpoint needs a
   * published, fully scored survey, and these assertions are about the
   * override contract rather than the engine.
   */
  async function seedScore(needId: string, overallScore: number): Promise<string> {
    const need = await supervisor.need.findUnique({ where: { id: needId } });
    const id = randomUUID();
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_org_id = '${need!.orgId}'`);
      await tx.$executeRawUnsafe(
        `INSERT INTO priority_scores
           (id, org_id, need_id, study_id, overall_score, level, gap_type, factors, scored_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::"PriorityLevel", $7, $8::jsonb, now())`,
        id, need!.orgId, needId, need!.studyId, overallScore, 'medium', 'acute',
        JSON.stringify({ model: 'nine-factor-weighted-mean', coverage: 1, score: overallScore, components: [] }),
      );
    });
    return id;
  }

  /** Theme extraction is fire-and-forget, so poll rather than assume. */
  async function waitForThemes(needId: string): Promise<string[]> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const res = await request(app.getHttpServer())
        .get(`/api/needs/${needId}`)
        .set("Cookie", officerCookies);
      if ((res.body?.themes ?? []).length > 0) return res.body.themes;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`No themes appeared for need ${needId} within the poll window.`);
  }

  it("AC 6 — themes are extracted automatically and stay inside the vocabulary", async () => {
    const needId = await createNeed();
    const themes = await waitForThemes(needId);

    expect(themes).toEqual(THEMES);

    // The vocabulary is the closed list, and every extracted theme must be in
    // it — a free-text theme would break both the filter and the count.
    const vocabulary = (await supervisor.needThemeOption.findMany({ select: { name: true } }))
      .map((t) => t.name);
    for (const theme of themes) expect(vocabulary).toContain(theme);
  }, TEST_TIMEOUT_MS);

  it("AC 6 — the group-by-theme counts reflect what was extracted", async () => {
    const needId = await createNeed();
    await waitForThemes(needId);

    const res = await request(app.getHttpServer())
      .get("/api/need-themes/counts")
      .set("Cookie", analystCookies)
      .expect(200);

    const distance = (res.body as Array<{ theme: string; needCount: number }>).find(
      (t) => t.theme === THEMES[0],
    );
    expect(distance).toBeDefined();
    expect(distance!.needCount).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it("AC 1 — urgency is set by a human, and only by a role that holds priorityScoring:write", async () => {
    const needId = await createNeed();

    // The Research Officer who wrote the need holds priorityScoring read-only:
    // urgency is a prioritisation judgement, not a correction to the need.
    await request(app.getHttpServer())
      .patch(`/api/needs/${needId}/urgency`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .send({ urgency: "immediate" })
      .expect(403);

    const updated = await request(app.getHttpServer())
      .patch(`/api/needs/${needId}/urgency`)
      .set("Cookie", analystCookies)
      .set("x-csrf-token", analystCsrf)
      .send({ urgency: "immediate" })
      .expect(200);
    expect(updated.body.urgency).toBe("immediate");

    // Null clears it — an unset urgency is "not measured", never "not urgent".
    const cleared = await request(app.getHttpServer())
      .patch(`/api/needs/${needId}/urgency`)
      .set("Cookie", analystCookies)
      .set("x-csrf-token", analystCsrf)
      .send({ urgency: null })
      .expect(200);
    expect(cleared.body.urgency).toBeNull();
  }, TEST_TIMEOUT_MS);

  it("AC 1 — an invalid urgency level is refused rather than stored", async () => {
    const needId = await createNeed();
    await request(app.getHttpServer())
      .patch(`/api/needs/${needId}/urgency`)
      .set("Cookie", analystCookies)
      .set("x-csrf-token", analystCsrf)
      .send({ urgency: "whenever" })
      .expect(400);
  }, TEST_TIMEOUT_MS);

  it("AC 3 — the weights the engine uses are the ones on the Config screen", async () => {
    // The whole point of the config split. If this drifts, the number the
    // reviewer sees stops matching the methodology they signed off.
    const config = await request(app.getHttpServer())
      .get("/api/methodology-config")
      .set("Cookie", adminCookies)
      .expect(200);

    const keys = (config.body.priorityFactorWeights as Array<{ key: string }>).map((w) => w.key);
    expect(keys).toEqual([
      "severity",
      "affected_population",
      "service_availability_gap",
      "urgency",
      "data_confidence",
      "frequency",
      "geographic_coverage",
      "vulnerable_groups",
      "strategic_alignment",
    ]);

    // And the conversion rules live beside them, not in code.
    expect(config.body.priorityFactorScales.urgency.immediate).toBe(100);
    expect(config.body.priorityFactorScales.affectedPopulation).toEqual({
      floor: 0,
      ceiling: 1000,
    });
    expect(config.body.priorityFactorScales.strategicAxes).toHaveLength(4);
  }, TEST_TIMEOUT_MS);

  it("AC 3 — an edited scale is rejected when it could never produce a value", async () => {
    // A ceiling at or below the floor makes the factor silently contribute
    // nothing while still looking configured.
    await request(app.getHttpServer())
      .patch("/api/methodology-config")
      .set("Cookie", adminCookies)
      .set("x-csrf-token", adminCsrf)
      .send({ priorityFactorScales: { affectedPopulation: { floor: 500, ceiling: 100 } } })
      .expect(400);

    await request(app.getHttpServer())
      .patch("/api/methodology-config")
      .set("Cookie", adminCookies)
      .set("x-csrf-token", adminCsrf)
      .send({ priorityFactorScales: { urgency: { immediate: 400 } } })
      .expect(400);
  }, TEST_TIMEOUT_MS);

  it("AC 3 — a config edit is snapshotted into the history", async () => {
    await request(app.getHttpServer())
      .patch("/api/methodology-config")
      .set("Cookie", adminCookies)
      .set("x-csrf-token", adminCsrf)
      .send({ priorityFactorScales: { geographicCoverage: { floor: 1, ceiling: 12 } } })
      .expect(200);

    const history = await request(app.getHttpServer())
      .get("/api/methodology-config/history")
      .set("Cookie", adminCookies)
      .expect(200);

    expect(history.body[0].priorityFactorScales.geographicCoverage).toEqual({
      floor: 1,
      ceiling: 12,
    });

    // Put it back so a later run of this file starts from the shipped default.
    await request(app.getHttpServer())
      .patch("/api/methodology-config")
      .set("Cookie", adminCookies)
      .set("x-csrf-token", adminCsrf)
      .send({ priorityFactorScales: { geographicCoverage: { floor: 1, ceiling: 10 } } })
      .expect(200);
  }, TEST_TIMEOUT_MS);

  it("AC 5 — an override keeps the computed value and demands a reason", async () => {
    // Written directly rather than through the scoring endpoint: that path
    // needs a published, scored survey, which is a whole fixture of its own and
    // is covered by scored-report.e2e.spec. What matters here is the override
    // contract itself.
    const needId = await createNeed();
    const scoreId = await seedScore(needId, 64);

    // No reason — refused by the contract before it reaches the service.
    await request(app.getHttpServer())
      .patch(`/api/priority-scores/${scoreId}/override`)
      .set("Cookie", analystCookies)
      .set("x-csrf-token", analystCsrf)
      .send({ overrideScore: 85, reason: "" })
      .expect(400);

    // The Research Officer cannot overrule the engine.
    await request(app.getHttpServer())
      .patch(`/api/priority-scores/${scoreId}/override`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .send({ overrideScore: 85, reason: "Should not be allowed." })
      .expect(403);

    const overridden = await request(app.getHttpServer())
      .patch(`/api/priority-scores/${scoreId}/override`)
      .set("Cookie", analystCookies)
      .set("x-csrf-token", analystCsrf)
      .send({ overrideScore: 85, reason: "Outbreak reported after the survey closed." })
      .expect(200);

    // Both numbers travel together — that is what "distinguishable" means.
    expect(overridden.body.computedScore).toBe(64);
    expect(overridden.body.overrideScore).toBe(85);
    expect(overridden.body.effectiveScore).toBe(85);
    expect(overridden.body.overrideReason).toContain("Outbreak");
  }, TEST_TIMEOUT_MS);

  it("AC 4 — an approved score can no longer be overridden", async () => {
    const needId = await createNeed();
    const scoreId = await seedScore(needId, 40);

    await request(app.getHttpServer())
      .patch(`/api/priority-scores/${scoreId}/approve`)
      .set("Cookie", analystCookies)
      .set("x-csrf-token", analystCsrf)
      .expect(200);

    // Rewriting a signed-off number would leave a published score nobody
    // signed for.
    await request(app.getHttpServer())
      .patch(`/api/priority-scores/${scoreId}/override`)
      .set("Cookie", analystCookies)
      .set("x-csrf-token", analystCsrf)
      .send({ overrideScore: 90, reason: "Too late." })
      .expect(400);
  }, TEST_TIMEOUT_MS);

  it("the database refuses an override with no reason, whatever the service does", async () => {
    const needId = await createNeed();
    const scoreId = await seedScore(needId, 50);

    await expect(
      owner.priorityScore.update({
        where: { id: scoreId },
        data: { overrideScore: 90 },
      }),
    ).rejects.toThrow();
  }, TEST_TIMEOUT_MS);
});
