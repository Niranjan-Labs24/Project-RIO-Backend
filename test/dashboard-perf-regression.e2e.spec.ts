import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/http-exception.filter";

// RIO-NFR-005 (AC: "dashboard load within the MVP performance target agreed
// during technical design") — that target was never actually agreed (see
// load-test/README.md); we're proceeding with our own working target of
// < 3 seconds for full dashboard load. This test cannot measure the full
// figure — there is no browser in this environment, so frontend render time
// is untested here. What it CAN measure, automatically, on every CI run: the
// real backend API call the Priority Dashboard makes on load
// (`GET /api/priority-scores`, see priority.service.ts's `listDashboard`).
// Budgeted at 1.5s — half the 3s total target — leaving headroom for
// frontend render, which is the part this test cannot see.
//
// Genuine gap, not silently covered by this test: the System Admin Dashboard
// and main Dashboard's `studiesService.getPlatformStats()` call is frontend
// mock data (a hardcoded array + artificial delay, not a real backend
// endpoint) — there's nothing real to time there yet, so this test doesn't
// claim to cover those two dashboards' data-fetch performance.
const API_BUDGET_MS = 1_500;

describe("RIO-NFR-005 — dashboard-load performance regression", () => {
  let app: INestApplication;
  let adminAuth: { cookies: string[]; csrf: string };

  async function loginAs(email: string): Promise<{ cookies: string[]; csrf: string }> {
    const login = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email, password: "Passw0rd!" })
      .expect(200);
    const cookies = login.headers["set-cookie"] as unknown as string[];
    const csrf = cookies.find((c) => c.startsWith("rio_csrf="))?.match(/rio_csrf=([^;]*)/)?.[1] ?? "";
    return { cookies, csrf };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    adminAuth = await loginAs("sysadmin@platform.local");
  });

  afterAll(async () => {
    await app.close();
  });

  const as =
    (who: { cookies: string[]; csrf: string }) =>
    <T extends request.Test>(r: T) =>
      r.set("Cookie", who.cookies).set("X-CSRF-Token", who.csrf);

  it("Priority Dashboard's data fetch stays within the API-side budget", async () => {
    const server = app.getHttpServer();
    const admin = as(adminAuth);

    // Warm-up: same rationale as the report-generation regression test —
    // absorbs this test file's own first-call cost so the timed assertion
    // reflects steady-state performance.
    await admin(request(server).get("/api/priority-scores")).expect(200);

    const start = performance.now();
    await admin(request(server).get("/api/priority-scores")).expect(200);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(API_BUDGET_MS);

    console.log(
      `RIO-NFR-005 dashboard-load regression — GET /api/priority-scores ${elapsedMs.toFixed(0)}ms ` +
        `(budget ${API_BUDGET_MS}ms; full dashboard-load target is 3000ms including frontend render, untested here).`,
    );
  });
});
