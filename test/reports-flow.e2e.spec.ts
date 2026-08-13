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
// RIO-RBAC-001 module-permission matrix (client-confirmed, Aug 11, refined
// Aug 12): Reports is split across actors, not one "admin does everything"
// login — ngo_admin's grant is View/Export/Share only (no Create/Edit/
// Approve). Researcher holds Create + Edit, so they create AND confirm
// their own draft (the "officer" of the two-step workflow); Human Reviewer
// is the independent approver (Approve/Export/Archive). System Admin login
// is kept only to exercise the pre-release export block with a role that
// actually holds Reports:Export, so that check proves the real
// REPORT_NOT_RELEASED business rule rather than a permission 403. Create
// RPT14 (draft) → prove a draft can't export → officer confirm → reviewer
// approve (release) → export PDF + Excel (written to disk so you can open
// them) → archive. Watch the console for the export folder path.
describe("Reports lifecycle flow (RPT14 Village Report)", () => {
  let app: INestApplication;
  let officerAuth: { cookies: string[]; csrf: string };
  let adminAuth: { cookies: string[]; csrf: string };
  let reviewerAuth: { cookies: string[]; csrf: string };

  const OUT = join(tmpdir(), "rio-report-exports");

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
    mkdirSync(OUT, { recursive: true });

    // Seeded demo accounts; password is the seed's DEV_PASSWORD. login is
    // CSRF-exempt and issues each account's own cookies.
    officerAuth = await loginAs("officer@demo-ngo.org");
    adminAuth = await loginAs("sysadmin@platform.local");
    reviewerAuth = await loginAs("reviewer@demo-ngo.org");
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
  const as =
    (who: { cookies: string[]; csrf: string }) =>
    <T extends request.Test>(r: T) =>
      r.set("Cookie", who.cookies).set("X-CSRF-Token", who.csrf);

  it("walks create → confirm → approve → export → archive", async () => {
    const server = app.getHttpServer();
    const officer = as(officerAuth);
    const admin = as(adminAuth);
    const reviewer = as(reviewerAuth);

    // 0. RPT14 needs a SCORED study — there is no mock fallback any more, so an
    //    un-scored study is rejected outright (see step 0b). `pnpm seed:scored`
    //    creates this one specifically to exercise the real pipeline.
    const studies = await officer(request(server).get("/api/studies")).expect(200);
    const items: Array<{ id: string; title: string }> = studies.body.items ?? [];
    if (!items.length) {
      throw new Error("No study found — run `pnpm prisma:seed` first, then re-run this test.");
    }
    const scored = items.find((s) => s.title === "Scored Assessment — Ad-Dilam");
    if (!scored) {
      throw new Error("No scored study found — run `pnpm seed:scored` first, then re-run this test.");
    }
    const studyId = scored.id;

    // 0b. An un-scored study is a 409, not a fabricated report. (Before the mock
    //     was removed this returned 201 with Sample Village fixtures.)
    const unscored = items.find((s) => s.id !== studyId);
    if (unscored) {
      await officer(request(server).post("/api/reports"))
        .send({ reportType: "RPT14", studyId: unscored.id, filters: { villageId: "Ad-Dilam" } })
        .expect(409)
        .expect((r) => expect(r.body.error.code).toBe("STUDY_NOT_SCORED"));
    }

    // 1. Create → starts in draft. Researcher holds Reports:Create.
    const created = await officer(request(server).post("/api/reports"))
      .send({ reportType: "RPT14", studyId, filters: { villageId: "Ad-Dilam" } })
      .expect(201);
    const id = created.body.id;
    expect(created.body.status).toBe("draft");
    expect(created.body.content.priority.priorityStatus).toBe("HIGH"); // from the provider seam
    expect(created.body.exportFormats).toEqual(["pdf", "excel"]);

    // 2. A draft may NOT be exported (reviewer approval required).
    await admin(request(server).get(`/api/reports/${id}/export`).query({ format: "pdf" }))
      .expect(403)
      .expect((r) => expect(r.body.error.code).toBe("REPORT_NOT_RELEASED"));

    // 3. Approving before officer-confirm is blocked (two-step guard).
    await reviewer(request(server).patch(`/api/reports/${id}/approve`).send({ notes: "Looks good" }))
      .expect(403)
      .expect((r) => expect(r.body.error.code).toBe("REPORT_NOT_CONFIRMED"));

    // 4. Officer confirms their own draft → still draft, officer fields set.
    //    Researcher holds Reports:Edit alongside Create (Aug 12 refinement).
    const confirmed = await officer(request(server).patch(`/api/reports/${id}/confirm`)).expect(200);
    expect(confirmed.body.status).toBe("draft");
    expect(confirmed.body.officerConfirmedAt).not.toBeNull();

    // 5. Reviewer approves → released. Notes are mandatory (RIO-FR-007).
    const released = await reviewer(
      request(server).patch(`/api/reports/${id}/approve`).send({ notes: "Looks good" }),
    ).expect(200);
    expect(released.body.status).toBe("released");
    expect(released.body.reviewedAt).not.toBeNull();
    expect(released.body.reviewerNotes).toBe("Looks good");

    // 6. Export PDF + Excel (now allowed) — save to disk.
    for (const [format, ext] of [["pdf", "pdf"], ["excel", "xlsx"]] as const) {
      const res = await reviewer(request(server).get(`/api/reports/${id}/export`).query({ format }))
        .buffer(true)
        .parse(binary)
        .expect(200);
      const body = res.body as Buffer;
      expect(body.length).toBeGreaterThan(2000);
      const file = join(OUT, `RPT14-${id}.${ext}`);
      writeFileSync(file, body);

      console.log(`  ✓ ${format} export → ${file} (${body.length} bytes)`);
    }

    // 7. Archive → archived (searchable, read-only).
    const archived = await reviewer(request(server).patch(`/api/reports/${id}/archive`)).expect(200);
    expect(archived.body.status).toBe("archived");

    // 8. Archived reports are still exportable.
    await reviewer(request(server).get(`/api/reports/${id}/export`).query({ format: "pdf" })).expect(200);


    console.log(`\n  Open the exported files in: ${OUT}\n`);
  }, 30_000);
});
