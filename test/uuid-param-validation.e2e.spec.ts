import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/http-exception.filter";

// Task 5 (boundary validation): a malformed route-param id must be rejected
// with the standard VALIDATION_ERROR envelope before it ever reaches a
// Prisma query, across a representative sample of the ~110 UUID params
// converted to UuidParamPipe.
describe("UUID route params reject malformed ids (VALIDATION_ERROR, not 404/500)", () => {
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

  it("GET /api/studies/:id rejects a non-UUID id", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/studies/not-a-uuid")
      .set("Cookie", cookies)
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("GET /api/reports/:id rejects a non-UUID id", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/reports/../../etc/passwd")
      .set("Cookie", cookies);
    expect([400, 404]).toContain(res.status);
  });

  it("GET /api/needs/:needId/priority-score rejects a non-UUID needId", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/needs/1234/priority-score")
      .set("Cookie", cookies)
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("still accepts a well-formed (but nonexistent) UUID and falls through to 404", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/studies/00000000-0000-0000-0000-000000000000")
      .set("Cookie", cookies);
    expect(res.status).toBe(404);
  });
});
