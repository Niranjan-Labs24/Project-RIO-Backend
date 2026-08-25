import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { orgContext } from "../src/tenancy/org-context";
import { ReportDataProvider } from "../src/modules/reports/providers/report-data.provider";
import { TenantPrismaService } from "../src/tenancy/tenant-prisma.service";
import { buildReportDoc } from "../src/modules/reports/report-doc";

describe("TEMP verify: RPT03 + RPT10 on seeded data", () => {
  let app: INestApplication;
  let provider: ReportDataProvider;
  let tenant: TenantPrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    provider = app.get(ReportDataProvider);
    tenant = app.get(TenantPrismaService);
  }, 60000);
  afterAll(async () => app.close());

  it("renders both", async () => {
    const orgId = "01a022cb-983c-7753-b973-d8a60af5378a";
    const study = await orgContext.run({ requestId: "v", orgId }, () =>
      tenant.runInOrgContext((tx) =>
        tx.study.findFirst({ where: { title: "Scored Assessment — Ad-Dilam" }, select: { id: true, title: true } }),
      ),
    );
    await orgContext.run({ requestId: "v", orgId, actorId: "v" }, async () => {
      const q = { studyId: study!.id, orgId, studyTitle: study!.title, filters: {} };
      const top = (await provider.getTopPriorityReport(q)) as unknown as Record<string, unknown>;
      console.log("RPT03 OK sections:", buildReportDoc("Top-Priority", top, []).sections.map((s) => ("heading" in s ? s.heading : "")).filter(Boolean).join(" | "));

      const dq = (await provider.getDataQualityReport(q)) as unknown as Record<string, unknown>;
      const doc = buildReportDoc("Data-Quality", dq, []);
      console.log("RPT10 OK sections:", doc.sections.map((s) => ("heading" in s ? s.heading : "")).filter(Boolean).join(" | "));
      const dc = dq.dataCollection as Record<string, any>;
      console.log("RPT10 abandonment:", JSON.stringify({
        started: dc.abandonment.sessionsStarted, submitted: dc.abandonment.submitted,
        abandoned: dc.abandonment.abandoned, inFlight: dc.abandonment.inFlight,
        ratePct: dc.abandonment.abandonmentRatePct, byStage: dc.abandonment.byStage.map((s: any) => `${s.stage}:${s.count}`),
      }));
      console.log("RPT10 invalid:", JSON.stringify(dc.invalidResponses));
      console.log("RPT10 unanswered:", JSON.stringify({
        required: dc.unansweredRequired.requiredQuestionCount, slots: dc.unansweredRequired.requiredAnswerSlots,
        blank: dc.unansweredRequired.unansweredCount, ratePct: dc.unansweredRequired.unansweredRatePct,
        rows: dc.unansweredRequired.byQuestion.length,
      }));
      console.log("RPT10 scope:", JSON.stringify({ level: dc.scope.level, covered: dc.scope.coveredSurveys.length, excluded: dc.scope.excludedSurveys.length }));
      console.log("RPT10 flags:", JSON.stringify((dq.flaggedRecords as any[]).reduce((m: any, f: any) => ({ ...m, [f.flag]: (m[f.flag] ?? 0) + 1 }), {})));
    });
  }, 240000);
});
