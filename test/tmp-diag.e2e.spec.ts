import { Test } from "@nestjs/testing";
import { appendFileSync } from "node:fs";
import { AppModule } from "../src/app.module";
import { TenantPrismaService } from "../src/tenancy/tenant-prisma.service";

// TEMPORARY diagnostic — confirms domain rollups duplicate per village. Delete after.
describe("diag", () => {
  it("groups DOMAIN rollups by (survey, villageId, entityId)", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const tenant = app.get(TenantPrismaService);

    const out: string[] = [];
    await tenant.runAsSupervisor(async (tx) => {
      const rows = await tx.scoreRollup.findMany({
        where: { rollupLevel: "DOMAIN" },
        select: {
          studyId: true,
          surveyId: true,
          villageId: true,
          entityId: true,
          severityScore: true,
          validResponseCount: true,
        },
        orderBy: [{ surveyId: "asc" }, { entityId: "asc" }],
      });
      const bySurvey = new Map<string, typeof rows>();
      for (const r of rows) {
        const list = bySurvey.get(r.surveyId) ?? [];
        list.push(r);
        bySurvey.set(r.surveyId, list);
      }
      for (const [surveyId, list] of bySurvey) {
        const villages = new Set(list.map((r) => r.villageId ?? "<null>"));
        const domains = new Set(list.map((r) => r.entityId));
        out.push(
          `survey ${surveyId.slice(0, 8)}: ${list.length} DOMAIN rows | ${villages.size} village(s) [${[...villages].join(", ")}] | ${domains.size} distinct domain(s)`,
        );
        if (list.length !== domains.size) {
          for (const r of list) {
            out.push(
              `    village="${r.villageId ?? "<null>"}" domain="${r.entityId}" sev=${r.severityScore} valid=${r.validResponseCount}`,
            );
          }
        }
      }
    });

    appendFileSync("diag.txt", out.join("\n") + "\n");
    await app.close();
  }, 120_000);
});
