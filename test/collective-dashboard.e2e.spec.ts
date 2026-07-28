import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/http-exception.filter";

// Requires a migrated + seeded DB (pnpm prisma:seed). Verifies the Collective
// Dashboard endpoint assembles provider analytics + live reviewer-SLA figures.
describe("GET /collective-dashboard", () => {
  let app: INestApplication;
  let cookies: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    const login = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "admin@demo-ngo.org", password: "Passw0rd!" })
      .expect(200);
    cookies = login.headers["set-cookie"] as unknown as string[];
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns KPIs (needs, scoring, SLA) and an executive summary", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/collective-dashboard")
      .set("Cookie", cookies)
      .expect(200);

    const b = res.body;
    expect(b.kpis.needCount).toBeGreaterThan(0);
    expect(Array.isArray(b.kpis.scoringDistribution)).toBe(true);
    // SLA fields come from the live reviewer-sla queue (numbers, compliance % or null).
    expect(b.kpis).toHaveProperty("slaBreaches");
    expect(b.kpis).toHaveProperty("slaCompliancePct");
    expect(typeof b.scope.studyCount).toBe("number");
    expect(Array.isArray(b.executiveSummary.topPriorities)).toBe(true);
    expect(Array.isArray(b.executiveSummary.trends)).toBe(true);
    expect(Array.isArray(b.executiveSummary.anomalies)).toBe(true);
    expect(Array.isArray(b.executiveSummary.reviewerNotes)).toBe(true);
  }, 20_000);

  it("denies unauthenticated callers", async () => {
    // JwtAuthGuard hard-blocks any non-@Public() route with no valid
    // session before the permission guard even runs, so a caller with no
    // token gets 401 here, not 403 — there's no seeded user without
    // reportsDashboards:read to exercise a true permission-denied case.
    await request(app.getHttpServer()).get("/api/collective-dashboard").expect(401);
  });
});
