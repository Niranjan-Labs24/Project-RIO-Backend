import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/http-exception.filter";

// Verifies the REAL report pipeline end-to-end against the scored seed study.
// Requires: pnpm prisma:seed && pnpm seed:scored
describe("RPT14 from a scored study uses REAL data", () => {
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
  afterAll(async () => app.close());

  it("renders real severity/priority/gender (entityName = org name, not the mock's null)", async () => {
    const studies = await request(app.getHttpServer()).get("/api/studies").set("Cookie", cookies).expect(200);
    const study = (studies.body.items ?? []).find((s: { title: string }) => s.title.includes("Scored Assessment"));
    if (!study) throw new Error("Run `pnpm seed:scored` first (scored study not found).");

    const res = await request(app.getHttpServer())
      .post("/api/reports")
      .set("Cookie", cookies)
      .send({ reportType: "RPT14", studyId: study.id, filters: { villageId: "Ad-Dilam" } })
      .expect(201);

    const c = res.body.content;
    // The tell: the real provider fills entityName from the org; the mock leaves it null.
    expect(c.header.entityName).toBe("Demo NGO");
    expect(c.village.name).toBe("Ad-Dilam");
    expect(c.severity.overallVillageNeedsIndex).toBeCloseTo(63.8);
    expect(c.priority.priorityStatus).toBe("HIGH");
    // Real gender aggregation from the 38 seeded responses (21F / 17M).
    const female = c.demographics?.gender?.find((g: { label: string }) => g.label === "Female");
    expect(female?.count).toBe(21);
  }, 30_000);
});
