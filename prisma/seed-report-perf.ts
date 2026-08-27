import "dotenv/config";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { pgSslFromEnv } from "../src/prisma/pg-ssl";

// RIO-NFR-005 report-generation timing — a SEPARATE fixture from
// seed-scored-study.ts (which several specs hardcode assertions against,
// e.g. `validResponses: 38`). This one exists only to give report
// generation something closer to our own working "pilot-scale" data-volume
// assumption (~200 responses for one study/survey — see load-test/README.md)
// than that 38-response fixture, so a report-generation timing run isn't
// measuring a near-empty dataset. Not a scoring-correctness fixture — the
// domain/KPI severity numbers are carried over unchanged from the 38-response
// fixture, just with validResponseCount/excludedResponseCount/dontKnowCount
// scaled proportionally so they stay internally consistent with the new
// response total. Idempotent: re-running skips if the study already exists.
// Run: pnpm seed:report-perf
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() }),
});
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }),
});

async function setOrg(tx: { $executeRawUnsafe: (s: string) => Promise<number> }, orgId: string): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${orgId}', true)`);
}

const STUDY_TITLE = "Performance Test Assessment — Pilot Scale";
const VILLAGE = "Pilot Village";
const CALC = "seed-perf-v1";
const RESPONSE_COUNT = 200;

// Same domains/KPIs as seed-scored-study.ts, response-count fields scaled up
// ~5.26x (200/38) and rounded — severity/weight/critical-flag values kept
// identical since this fixture is about report-generation timing at a
// realistic response volume, not re-validating scoring math.
const DOMAINS = [
  { key: "HEALTH", name: "Health", sev: 72, perf: 28, weight: 0.3, wc: 8.4, critical: true, conf: "STANDARD", valid: 184 },
  { key: "EDUCATION", name: "Education", sev: 48, perf: 52, weight: 0.25, wc: 13.0, critical: false, conf: "STANDARD", valid: 189 },
  { key: "INFRASTRUCTURE", name: "Infrastructure", sev: 63, perf: 37, weight: 0.2, wc: 7.4, critical: false, conf: "STANDARD", valid: 179 },
  { key: "LIVELIHOOD", name: "Livelihood", sev: 55, perf: 45, weight: 0.15, wc: 6.75, critical: false, conf: "STANDARD", valid: 174 },
  { key: "WATER_SANITATION", name: "Water & Sanitation", sev: 81, perf: 19, weight: 0.1, wc: 1.9, critical: true, conf: "LOW", valid: 42 },
];
const KPIS = [
  { id: "KPI_WATER_ACCESS", name: "Daily Clean Water Access", sev: 88, conf: "LOW", valid: 42 },
  { id: "KPI_MEDICINE", name: "Availability of Essential Medicines", sev: 78, conf: "STANDARD", valid: 184 },
  { id: "KPI_HEALTH_DISTANCE", name: "Distance to Primary Health Facility", sev: 72, conf: "STANDARD", valid: 189 },
];

async function main(): Promise<void> {
  const admin = await supervisor.user.findFirst({ where: { email: "admin@demo-ngo.org" } });
  if (!admin) throw new Error("Run `pnpm prisma:seed` first (admin@demo-ngo.org not found).");
  const orgId = admin.orgId;
  const createdBy = admin.id;
  const org = await supervisor.organisation.findUnique({ where: { id: orgId }, select: { regionId: true } });

  const mv = await prisma.methodologyVersion.findFirst({ orderBy: { createdAt: "asc" } });
  if (!mv) throw new Error("No MethodologyVersion found — run the main seed / imports first.");

  await prisma.$transaction(
    async (tx) => {
      await setOrg(tx, orgId);

      const existing = await tx.study.findFirst({ where: { orgId, title: STUDY_TITLE } });
      if (existing) {
        console.log(`Already seeded: study "${STUDY_TITLE}" (${existing.id}). Nothing to do.`);
        return;
      }

      const maxCycle = await tx.study.aggregate({ where: { orgId }, _max: { cycleNumber: true } });
      const cycleNumber = (maxCycle._max.cycleNumber ?? 0) + 1;

      const study = await tx.study.create({
        data: { orgId, title: STUDY_TITLE, villages: [VILLAGE], cycleNumber, methodologyVersionId: mv.id, createdBy },
      });

      const need = await tx.need.create({
        data: {
          orgId,
          studyId: study.id,
          title: "Community water & health needs (pilot-scale perf fixture)",
          statement: "Assessment of water, sanitation, and health needs at pilot response volume.",
          source: "field_survey",
          village: [VILLAGE],
          domain: "Water & Sanitation",
          subDomain: "Drinking Water Access",
          createdBy,
        },
      });
      await tx.needDomain.create({
        data: { needId: need.id, orgId, domain: "Water & Sanitation", subDomain: "Drinking Water Access" },
      });

      const survey = await tx.survey.create({
        data: {
          orgId,
          needId: need.id,
          studyId: study.id,
          title: "Pilot Village Needs Survey",
          status: "PUBLISHED",
          methodologyVersion: mv.version,
          publishedAt: new Date(),
          approverComments: "System-generated seed data (report-generation perf fixture)",
          createdBy,
        },
      });

      const link = await tx.publicSurveyLink.create({
        data: { orgId, needId: need.id, studyId: study.id, label: "Perf Fixture Link", token: randomBytes(16).toString("hex"), createdBy },
      });

      // Same 21F:17M ratio as the 38-response fixture, scaled to 200 (110F/90M).
      const femaleCount = Math.round(RESPONSE_COUNT * (21 / 38));
      await tx.surveyResponse.createMany({
        data: Array.from({ length: RESPONSE_COUNT }, (_, i) => ({
          orgId,
          needId: need.id,
          studyId: study.id,
          surveyLinkId: link.id,
          contact: `perf-respondent-${i + 1}@seed.local`,
          gender: (i < femaleCount ? "female" : "male") as "female" | "male",
          settlementType: (i % 3 === 0 ? "urban" : "rural") as "rural" | "urban",
          village: [VILLAGE],
          regionId: org?.regionId ?? null,
          answers: {},
        })),
      });

      const common = { orgId, studyId: study.id, surveyId: survey.id, villageId: VILLAGE, methodologyVersionId: mv.id, calculationVersion: CALC };

      await tx.scoreRollup.create({
        data: {
          ...common,
          rollupLevel: "OVERALL",
          entityId: "OVERALL",
          entityNameSnapshot: "Overall",
          severityScore: 63.8,
          validResponseCount: RESPONSE_COUNT,
          excludedResponseCount: 21,
          dontKnowCount: 26,
          dontKnowRate: 0.124,
          notApplicableCount: 0,
          confidenceLevel: "STANDARD",
        },
      });

      await tx.scoreRollup.createMany({
        data: DOMAINS.map((d) => ({
          ...common,
          rollupLevel: "DOMAIN",
          entityId: d.key,
          entityNameSnapshot: d.name,
          severityScore: d.sev,
          validResponseCount: d.valid,
          excludedResponseCount: 0,
          dontKnowCount: d.conf === "LOW" ? 32 : 5,
          dontKnowRate: d.conf === "LOW" ? 0.25 : 0.05,
          notApplicableCount: 0,
          confidenceLevel: d.conf,
        })),
      });

      await tx.scoreRollup.createMany({
        data: KPIS.map((k) => ({
          ...common,
          rollupLevel: "KPI",
          entityId: k.id,
          entityNameSnapshot: k.name,
          severityScore: k.sev,
          validResponseCount: k.valid,
          excludedResponseCount: 0,
          dontKnowCount: k.conf === "LOW" ? 32 : 5,
          dontKnowRate: k.conf === "LOW" ? 0.25 : 0.05,
          notApplicableCount: 0,
          confidenceLevel: k.conf,
        })),
      });

      await tx.villagePriorityAssessment.create({
        data: {
          ...common,
          priorityScore: 37.45,
          priorityStatus: "HIGH",
          overrideApplied: true,
          overrideReason: "Critical Domain Override: Water & Sanitation performance score is 19, below the threshold of 30.",
          domainComponents: DOMAINS.map((d) => ({
            domainKey: d.key,
            domainNameSnapshot: d.name,
            domainSeverityScore: d.sev,
            domainPerformanceScore: d.perf,
            domainWeight: d.weight,
            weightedContribution: d.wc,
            isCriticalDomain: d.critical,
            criticalThreshold: 30,
            triggeredOverride: d.key === "WATER_SANITATION",
          })),
        },
      });

      await tx.evidence.createMany({
        data: [
          { orgId, needId: need.id, studyId: study.id, fileName: "water-report.pdf", fileType: "application/pdf", storageKey: "seed/perf-water-report.pdf", title: "Water shortage", sourceReferenceId: "REF-PW1", linkedDomainOrKpi: "Water & Sanitation", description: "Respondents reported irregular water supply and long travel distance to collect water.", reviewStatus: "APPROVED", isIncludedInReport: true, uploadedBy: createdBy },
          { orgId, needId: need.id, studyId: study.id, fileName: "health-notes.pdf", fileType: "application/pdf", storageKey: "seed/perf-health-notes.pdf", title: "Healthcare access", sourceReferenceId: "REF-PH1", linkedDomainOrKpi: "Health", description: "Community members highlighted medicine shortages and distance to nearby health facilities.", reviewStatus: "APPROVED", isIncludedInReport: true, uploadedBy: createdBy },
        ],
      });

      await tx.aiPrioritySummary.create({
        data: {
          orgId,
          studyId: study.id,
          surveyId: survey.id,
          villageId: VILLAGE,
          scopeFilters: { villageId: VILLAGE },
          reportDataSnapshotId: "seed-perf-snapshot",
          status: "OFFICER_CONFIRMED",
          summaryScope: "VILLAGE",
          promptHash: "seed-perf",
          inputReportDataHash: "seed-perf",
          inputEvidenceSnapshotHash: "seed-perf",
          aiOutputJson: {
            executiveSummary: `${VILLAGE} has a High Priority status driven by Water & Sanitation and Health.`,
            keyFindings: [
              { title: "Water severity", domain: "Water & Sanitation", kpi: "Access", confidence: "LOW", summary: "Water & Sanitation has the highest severity (81)." },
            ],
            dataQualityNote: "Water & Sanitation findings have Low Confidence relative to the overall response volume.",
            trendNote: "Cycle assessment: Trend Pending.",
            draftNextSteps: ["Validate water-access findings.", "Review medicine availability."],
          },
          generatedBy: createdBy,
          officerConfirmedBy: createdBy,
          officerConfirmedAt: new Date(),
        },
      });

      console.log(`✅ Seeded report-perf study "${STUDY_TITLE}" (${study.id})`);
      console.log(`   Survey ${survey.id} · village "${VILLAGE}" · ${RESPONSE_COUNT} responses (${femaleCount}F/${RESPONSE_COUNT - femaleCount}M) · OVERALL 63.8 · priority 37.45 HIGH`);
      console.log(`   → Reports → Generate → RPT14 → "${STUDY_TITLE}" → village "${VILLAGE}" now renders REAL data at pilot-scale volume.`);
    },
    { timeout: 30_000 },
  );
}

main()
  .then(async () => {
    await Promise.all([prisma.$disconnect(), supervisor.$disconnect()]);
  })
  .catch(async (e) => {
    console.error(e);
    await Promise.all([prisma.$disconnect(), supervisor.$disconnect()]);
    process.exit(1);
  });
