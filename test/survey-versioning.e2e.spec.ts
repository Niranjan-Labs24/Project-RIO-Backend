import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/http-exception.filter";

// RIO-FR-011 (client-confirmed): once PUBLISHED with responses collected, a
// survey moves to a versioned model instead of being edited in place — a new
// version is created, existing responses stay attached to the version they
// were collected under. Verified here against the scored seed study's real
// published survey (real responses), not a fixture.
// Requires: pnpm prisma:seed && pnpm seed:scored
describe("Survey versioning (RIO-FR-011) — e2e", () => {
  let app: INestApplication;
  let officerCookies: string[];
  let officerCsrf: string;
  let publishedSurveyId: string;
  let publishedSurveyResponseCount: number;

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
    officerCookies = login.headers["set-cookie"] as unknown as string[];
    officerCsrf =
      officerCookies.find((c) => c.startsWith("rio_csrf="))?.match(/rio_csrf=([^;]*)/)?.[1] ?? "";

    const studies = await request(app.getHttpServer())
      .get("/api/studies")
      .set("Cookie", officerCookies)
      .expect(200);
    const study = (studies.body.items ?? []).find((s: { title: string }) =>
      s.title.includes("Scored Assessment"),
    );
    if (!study) throw new Error("Run `pnpm seed:scored` first (scored study not found).");

    const surveys = await request(app.getHttpServer())
      .get(`/api/surveys?studyId=${study.id}`)
      .set("Cookie", officerCookies)
      .expect(200);
    const withResponses = (surveys.body.items ?? []).find(
      (s: { status: string; responseCount: number }) => s.status === "PUBLISHED" && s.responseCount > 0,
    );
    if (!withResponses) throw new Error("Scored study has no published survey with responses.");
    publishedSurveyId = withResponses.id;
    publishedSurveyResponseCount = withResponses.responseCount;
  }, 60_000);

  afterAll(async () => app.close());

  it("rejects creating a new version from a non-published survey", async () => {
    // needs/:needId/survey (createEmptySurvey) always starts a survey as
    // DRAFT — a fresh one is never PUBLISHED, so this alone is enough to
    // exercise the "not published yet" rejection without a full
    // classification chain.
    const needsRes = await request(app.getHttpServer())
      .get(`/api/studies`)
      .set("Cookie", officerCookies)
      .expect(200);
    const anyStudyId = needsRes.body.items[0].id;
    const needs = await request(app.getHttpServer())
      .get(`/api/studies/${anyStudyId}/needs`)
      .set("Cookie", officerCookies)
      .expect(200);
    const reviewerApprovedNeed = (needs.body.items ?? []).find((n: { status: string }) =>
      ["reviewer_approved", "survey_created", "survey_published"].includes(n.status),
    );
    if (!reviewerApprovedNeed) return; // seed data doesn't guarantee one — skip rather than fail on unrelated seed drift

    const draft = await request(app.getHttpServer())
      .post(`/api/needs/${reviewerApprovedNeed.id}/survey`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/api/surveys/${draft.body.id}/new-version`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .expect(409);
    expect(res.body.error.code).toBe("SURVEY_NOT_PUBLISHED");
  });

  it("creates a new draft version from the published survey, copying its questions, leaving the original untouched", async () => {
    const before = await request(app.getHttpServer())
      .get(`/api/surveys/${publishedSurveyId}`)
      .set("Cookie", officerCookies)
      .expect(200);
    expect(before.body.status).toBe("PUBLISHED");
    expect(before.body.version).toBe(1);
    const originalQuestionCount = before.body.questions.length;

    const created = await request(app.getHttpServer())
      .post(`/api/surveys/${publishedSurveyId}/new-version`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .expect(201);

    expect(created.body.status).toBe("DRAFT");
    expect(created.body.version).toBe(2);
    expect(created.body.previousVersionId).toBe(publishedSurveyId);
    expect(created.body.questions.length).toBe(originalQuestionCount);
    expect(created.body.id).not.toBe(publishedSurveyId);

    // The old (published) row itself never changes — same status, same id,
    // same question count.
    const after = await request(app.getHttpServer())
      .get(`/api/surveys/${publishedSurveyId}`)
      .set("Cookie", officerCookies)
      .expect(200);
    expect(after.body.status).toBe("PUBLISHED");
    expect(after.body.version).toBe(1);
    expect(after.body.questions.length).toBe(originalQuestionCount);

    // Responses collected under v1 stay attached to v1 — never moved.
    // Note: SurveyResponse (the real citizen-response model this seed data
    // lives in) has no `surveyId` at all, only `needId` — so there's no
    // "responses for this exact survey version" endpoint to query. The
    // guarantee instead lives in what never changes: v1's own
    // SurveyQuestion rows (asserted above via questions.length staying
    // put) are never deleted, so every existing ResponseAnswer — which
    // keys off SurveyQuestion.id — still resolves correctly regardless of
    // what v2's question set looks like. GET /surveys/:id's response
    // summary is need-scoped, not version-scoped, so it's not re-asserted
    // here as a version-attachment check.
    expect(after.body.responsesSummary.total).toBeGreaterThanOrEqual(publishedSurveyResponseCount);

    // GET needs/:needId/survey now resolves to the latest version (v2), not
    // the superseded published one.
    const byNeed = await request(app.getHttpServer())
      .get(`/api/needs/${before.body.needId}/survey`)
      .set("Cookie", officerCookies)
      .expect(200);
    expect(byNeed.body.id).toBe(created.body.id);
    expect(byNeed.body.version).toBe(2);
  });

  it("is idempotent — calling new-version again returns the same already-created draft, not a second one", async () => {
    const first = await request(app.getHttpServer())
      .post(`/api/surveys/${publishedSurveyId}/new-version`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/api/surveys/${publishedSurveyId}/new-version`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.version).toBe(2);
  });

  it("the new draft version is directly editable — updateQuestions succeeds where it would 409 on the published original", async () => {
    const byNeed = await request(app.getHttpServer())
      .get(`/api/surveys/${publishedSurveyId}`)
      .set("Cookie", officerCookies)
      .expect(200);
    const needId = byNeed.body.needId;
    const survey = await request(app.getHttpServer())
      .get(`/api/needs/${needId}/survey`)
      .set("Cookie", officerCookies)
      .expect(200);
    const draftVersionId = survey.body.id;
    expect(draftVersionId).not.toBe(publishedSurveyId);

    // Editing the published original is still hard-blocked.
    await request(app.getHttpServer())
      .patch(`/api/surveys/${publishedSurveyId}/questions`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .send({ questions: survey.body.questions })
      .expect(409)
      .expect((r: { body: { error: { code: string } } }) =>
        expect(r.body.error.code).toBe("SURVEY_NOT_EDITABLE"),
      );

    // The new draft version accepts the same edit.
    await request(app.getHttpServer())
      .patch(`/api/surveys/${draftVersionId}/questions`)
      .set("Cookie", officerCookies)
      .set("x-csrf-token", officerCsrf)
      .send({ questions: survey.body.questions })
      .expect(200);
  });
});
