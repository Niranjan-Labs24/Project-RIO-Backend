import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/http-exception.filter";

// End-to-end walk of the Reports feature built in Steps 0–4, against a real
// (migrated + SEEDED) DB. Run it with:
//
//     pnpm prisma:seed                       # once, if you haven't
//     pnpm vitest run test/reports-flow.e2e.spec.ts
//
// It logs in as the seeded demo admin, then: create RPT14 (draft) → prove a
// draft can't export → officer confirm → reviewer approve (release) → export
// PDF + Excel (written to disk so you can open them) → archive. Watch the
// console for the export folder path.
describe("Reports lifecycle flow (RPT14 Village Report)", () => {
  let app: INestApplication;
  let cookies: string[];
  let csrf: string;

  const OUT = join(tmpdir(), "rio-report-exports");

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    mkdirSync(OUT, { recursive: true });

    // Seeded demo admin (role ngo_admin → all report permissions). Password
    // is the seed's DEV_PASSWORD. login is CSRF-exempt and issues the cookies.
    const login = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "admin@demo-ngo.org", password: "Passw0rd!" })
      .expect(200);
    cookies = login.headers["set-cookie"] as unknown as string[];
    const csrfCookie = cookies.find((c) => c.startsWith("rio_csrf="));
    csrf = csrfCookie ? csrfCookie.split("=")[1].split(";")[0] : "";
  });

  afterAll(async () => {
    await app.close();
  });

  // supertest binary body parser so we can save the export bytes.
  const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  };
  const auth = <T extends request.Test>(r: T) => r.set("Cookie", cookies).set("X-CSRF-Token", csrf);

  it("walks create → confirm → approve → export → archive", async () => {
    const server = app.getHttpServer();

    // 0. Need a study for RPT14 (requiresStudyId). Use the seeded demo study.
    const studies = await auth(request(server).get("/api/studies")).expect(200);
    const items = studies.body.items ?? [];
    if (!items.length) {
      throw new Error("No study found — run `pnpm prisma:seed` first, then re-run this test.");
    }
    const studyId = items[0].id;

    // 1. Create → starts in draft.
    const created = await auth(request(server).post("/api/reports"))
      .send({ reportType: "RPT14", studyId, filters: { villageId: "Village A" } })
      .expect(201);
    const id = created.body.id;
    expect(created.body.status).toBe("draft");
    expect(created.body.content.priority.priorityStatus).toBe("HIGH"); // from the provider seam
    expect(created.body.exportFormats).toEqual(["pdf", "excel"]);

    // 2. A draft may NOT be exported (reviewer approval required).
    await auth(request(server).get(`/api/reports/${id}/export`).query({ format: "pdf" }))
      .expect(403)
      .expect((r) => expect(r.body.error.code).toBe("REPORT_NOT_RELEASED"));

    // 3. Approving before officer-confirm is blocked (two-step guard).
    await auth(request(server).patch(`/api/reports/${id}/approve`))
      .expect(403)
      .expect((r) => expect(r.body.error.code).toBe("REPORT_NOT_CONFIRMED"));

    // 4. Officer confirms → still draft, officer fields set.
    const confirmed = await auth(request(server).patch(`/api/reports/${id}/confirm`)).expect(200);
    expect(confirmed.body.status).toBe("draft");
    expect(confirmed.body.officerConfirmedAt).not.toBeNull();

    // 5. Reviewer approves → released.
    const released = await auth(request(server).patch(`/api/reports/${id}/approve`)).expect(200);
    expect(released.body.status).toBe("released");
    expect(released.body.reviewedAt).not.toBeNull();

    // 6. Export PDF + Excel (now allowed) — save to disk.
    for (const [format, ext] of [["pdf", "pdf"], ["excel", "xlsx"]] as const) {
      const res = await auth(request(server).get(`/api/reports/${id}/export`).query({ format }))
        .buffer(true)
        .parse(binary)
        .expect(200);
      const body = res.body as Buffer;
      expect(body.length).toBeGreaterThan(2000);
      const file = join(OUT, `RPT14-${id}.${ext}`);
      writeFileSync(file, body);
      // eslint-disable-next-line no-console
      console.log(`  ✓ ${format} export → ${file} (${body.length} bytes)`);
    }

    // 7. Archive → archived (searchable, read-only).
    const archived = await auth(request(server).patch(`/api/reports/${id}/archive`)).expect(200);
    expect(archived.body.status).toBe("archived");

    // 8. Archived reports are still exportable.
    await auth(request(server).get(`/api/reports/${id}/export`).query({ format: "pdf" })).expect(200);

    // eslint-disable-next-line no-console
    console.log(`\n  Open the exported files in: ${OUT}\n`);
  }, 30_000);
});
