import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/http-exception.filter";

// Verifies the survey-scoped reports (RPT01 Individual Survey, RPT15 Combined
// Survey + Dashboard) end-to-end against the scored seed study — REAL data, not
// the fixture provider the generator specs use.
// Requires: pnpm prisma:seed && pnpm seed:scored
// RIO-RBAC-001 matrix (Aug 11, refined Aug 12): Researcher holds
// Reports:Create + Edit (creates and confirms their own draft),
// Reports:Approve/Export is Human Reviewer's — ngo_admin only holds
// View/Export/Share, so a single "admin does everything" login no longer
// covers this whole flow.
describe("Survey-scoped reports (RPT01 / RPT15) — e2e", () => {
  let app: INestApplication;
  let cookies: string[];
  let csrf: string;
  let reviewerCookies: string[];
  let reviewerCsrf: string;
  let studyId: string;
  let surveyId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    const login = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "officer@demo-ngo.org", password: "Passw0rd!" })
      .expect(200);
    cookies = login.headers["set-cookie"] as unknown as string[];
    csrf = cookies.find((c) => c.startsWith("rio_csrf="))?.match(/rio_csrf=([^;]*)/)?.[1] ?? "";

    const reviewerLogin = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "reviewer@demo-ngo.org", password: "Passw0rd!" })
      .expect(200);
    reviewerCookies = reviewerLogin.headers["set-cookie"] as unknown as string[];
    reviewerCsrf = reviewerCookies.find((c) => c.startsWith("rio_csrf="))?.match(/rio_csrf=([^;]*)/)?.[1] ?? "";

    const studies = await request(app.getHttpServer()).get("/api/studies").set("Cookie", cookies).expect(200);
    const study = (studies.body.items ?? []).find((s: { title: string }) => s.title.includes("Scored Assessment"));
    if (!study) throw new Error("Run `pnpm seed:scored` first (scored study not found).");
    studyId = study.id;

    // The same list the Generate Report dialog's survey picker reads.
    const surveys = await request(app.getHttpServer())
      .get(`/api/surveys?studyId=${studyId}`)
      .set("Cookie", cookies)
      .expect(200);
    const withResponses = (surveys.body.items ?? []).filter((s: { responseCount: number }) => s.responseCount > 0);
    if (withResponses.length === 0) throw new Error("Scored study has no survey with responses.");
    surveyId = withResponses[0].id;
  }, 60_000);

  afterAll(async () => app.close());

  it("rejects a survey-scoped type with no surveyId", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/reports")
      .set("Cookie", cookies)
      .set("x-csrf-token", csrf)
      .send({ reportType: "RPT01", studyId })
      .expect(400);
    expect(res.body.error.code).toBe("SURVEY_ID_REQUIRED");
  });

  it("rejects a survey that belongs to a different study", async () => {
    const studies = await request(app.getHttpServer()).get("/api/studies").set("Cookie", cookies).expect(200);
    const other = (studies.body.items ?? []).find((s: { id: string }) => s.id !== studyId);
    if (!other) return; // single-study seed — nothing to cross-check against

    const res = await request(app.getHttpServer())
      .post("/api/reports")
      .set("Cookie", cookies)
      .set("x-csrf-token", csrf)
      .send({ reportType: "RPT01", studyId: other.id, surveyId })
      .expect(400);
    expect(res.body.error.code).toBe("SURVEY_NOT_IN_STUDY");
  }, 30_000);

  it("RPT01 generates from real data with real coverage counts", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/reports")
      .set("Cookie", cookies)
      .set("x-csrf-token", csrf)
      .send({ reportType: "RPT01", studyId, surveyId, filters: { villageId: "Ad-Dilam" } })
      .expect(201);

    // Persisted scoping — this is what makes two surveys' reports tellable apart.
    expect(res.body.surveyId).toBe(surveyId);
    expect(res.body.surveyTitle).toBeTruthy();

    const c = res.body.content;
    // The tell that this is the real provider, not a fixture: entityName is the org.
    expect(c.header.entityName).toBe("Demo NGO");
    expect(c.survey.surveyId).toBe(surveyId);

    // Counts are real and internally consistent.
    expect(c.coverage.responsesValid + c.coverage.responsesExcluded).toBe(c.coverage.responsesSubmitted);
    expect(c.coverage.surveyQuestionsFromBank + c.coverage.surveyQuestionsCustom).toBe(
      c.coverage.surveyQuestionsTotal,
    );
    expect(c.coverage.responsesSubmitted).toBeGreaterThan(0);
    expect(c.coverage.domainsScored).toBeGreaterThan(0);

    // Chart inputs are populated, not empty shells.
    expect(c.severity.domains.length).toBeGreaterThan(0);
    expect(c.responseFunnel.length).toBeGreaterThan(0);
    expect(c.topKpis.length).toBeGreaterThan(0);

    // The KPI→domain join never echoes the KPI back as its own domain, and
    // never emits the old hard-coded "Core Methodology Domain" literal. This
    // seed's top KPIs are synthetic fixtures with no methodology question
    // behind them, so they legitimately resolve to the honest fallback — the
    // join's resolving behaviour is proven in survey-report-derivations.spec.
    for (const k of c.topKpis as Array<{ kpi: string; domain: string }>) {
      expect(k.domain).not.toBe("Core Methodology Domain");
      expect(k.domain).not.toBe(k.kpi);
    }
  }, 60_000);

  it("RPT15 generates both halves and they reconcile with RPT01", async () => {
    const individual = await request(app.getHttpServer())
      .post("/api/reports")
      .set("Cookie", cookies)
      .set("x-csrf-token", csrf)
      .send({ reportType: "RPT01", studyId, surveyId, filters: { villageId: "Ad-Dilam" } })
      .expect(201);

    const combined = await request(app.getHttpServer())
      .post("/api/reports")
      .set("Cookie", cookies)
      .set("x-csrf-token", csrf)
      .send({ reportType: "RPT15", studyId, surveyId, filters: { villageId: "Ad-Dilam" } })
      .expect(201);

    const i = individual.body.content;
    const k = combined.body.content;

    // Reconciliation: the survey half must be the SAME numbers, not merely similar.
    expect(k.severity).toEqual(i.severity);
    expect(k.priority).toEqual(i.priority);
    expect(k.responseQuality).toEqual(i.responseQuality);
    expect(k.coverage).toEqual(i.coverage);

    // Dashboard half is present and agrees with the live dashboard endpoint.
    const dashboard = await request(app.getHttpServer())
      .get("/api/collective-dashboard")
      .set("Cookie", cookies)
      .expect(200);
    expect(k.dashboard.kpis.needCount).toBe(dashboard.body.kpis.needCount);
    expect(k.dashboard.capturedAt).toBeTruthy();

    // Org portfolio counts are real.
    expect(k.portfolio.studiesTotal).toBeGreaterThan(0);
    expect(k.portfolio.responsesTotal).toBeGreaterThanOrEqual(k.coverage.responsesSubmitted);

    // The comparison band never contradicts its own numbers.
    for (const row of k.comparison) {
      expect(row.delta).toBe(row.surveyValue - row.orgAverage);
    }
  }, 90_000);

  it("both types export to PDF and Excel once released", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/reports")
      .set("Cookie", cookies)
      .set("x-csrf-token", csrf)
      .send({ reportType: "RPT15", studyId, surveyId, filters: { villageId: "Ad-Dilam" } })
      .expect(201);
    const id = created.body.id;

    await request(app.getHttpServer())
      .patch(`/api/reports/${id}/confirm`)
      .set("Cookie", cookies)
      .set("x-csrf-token", csrf)
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/reports/${id}/approve`)
      .set("Cookie", reviewerCookies)
      .set("x-csrf-token", reviewerCsrf)
      .send({ notes: "Looks good" })
      .expect(200);

    // supertest doesn't buffer binary responses by default — same parser the
    // reports-flow e2e uses, otherwise res.body is an empty object.
    const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    };

    const pdf = await request(app.getHttpServer())
      .get(`/api/reports/${id}/export`)
      .query({ format: "pdf" })
      .set("Cookie", reviewerCookies)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    expect((pdf.body as Buffer).length).toBeGreaterThan(2000);

    const xlsx = await request(app.getHttpServer())
      .get(`/api/reports/${id}/export`)
      .query({ format: "excel" })
      .set("Cookie", reviewerCookies)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((xlsx.body as Buffer).length).toBeGreaterThan(2000);
  }, 90_000);
});
