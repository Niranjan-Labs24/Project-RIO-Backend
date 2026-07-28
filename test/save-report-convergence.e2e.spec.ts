import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { pgSslFromEnv } from "../src/prisma/pg-ssl";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/http-exception.filter";

// Verifies Phase C: saveReportFromSummary produces the SAME rich content the
// generators produce (not the old minimal { summaryId, aiOutput } blob).
// Requires: pnpm prisma:seed && pnpm seed:scored (which seeds a confirmed summary).
describe("saveReportFromSummary → rich content", () => {
  let app: INestApplication;
  let cookies: string[];
  let csrf: string;
  let summaryId: string;
  const supervisor = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }),
  });

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
    const csrfCookie = cookies.find((c) => c.startsWith("rio_csrf="));
    csrf = csrfCookie?.match(/rio_csrf=([^;]*)/)?.[1] ?? "";

    const study = await supervisor.study.findFirst({ where: { title: "Scored Assessment — Ad-Dilam" } });
    if (!study) throw new Error("Run `pnpm seed:scored` first.");
    const summary = await supervisor.aiPrioritySummary.findFirst({
      where: { studyId: study.id, status: "OFFICER_CONFIRMED" },
    });
    if (!summary) throw new Error("No confirmed summary — re-run `pnpm seed:scored`.");
    summaryId = summary.id;
  });

  afterAll(async () => {
    await app.close();
    await supervisor.$disconnect();
  });

  it("saves an RPT14 report with the full village content shape", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/priority-summaries/${summaryId}/save-report`)
      .set("Cookie", cookies)
      .set("x-csrf-token", csrf)
      .expect(201);

    const report = res.body;
    expect(report.reportType).toBe("RPT14");
    const c = report.content;
    // Rich shape — not the old { summaryId, aiOutput } blob.
    expect(c.header.entityName).toBe("Demo NGO");
    expect(c.village.name).toBe("Ad-Dilam");
    const water = c.severity.domains.find((d: { name: string }) => d.name === "Water & Sanitation");
    expect(water.severityScore).toBe(81);
    expect(c.priority.priorityStatus).toBe("HIGH");
    // Reused the confirmed AI narrative + real gender.
    expect(c.aiSummary.executiveSummary).toContain("High Priority");
    expect(c.aiSummary.recommendations).toContain("Validate water-access findings.");
    expect(c.demographics.gender.find((g: { label: string }) => g.label === "Female").count).toBe(21);
    // Real rural/urban from the structured SettlementType field (26 rural / 12 urban).
    expect(c.demographics.rural.find((r: { label: string }) => r.label === "Rural").count).toBe(26);
  }, 30_000);
});
