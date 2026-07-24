import "dotenv/config";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { pgSslFromEnv } from "../src/prisma/pg-ssl";

// Seeds ONE fully-scored study so the real report pipeline (buildReportDataSnapshot)
// returns real data instead of falling back to the mock. Idempotent: re-running
// skips if the study already exists. Run: pnpm seed:scored
//
// Chain: Study -> Need -> Survey -> PublicSurveyLink -> 38 SurveyResponses (with
// gender) -> ScoreRollups (OVERALL + 5 DOMAIN + 3 KPI) -> VillagePriorityAssessment
// -> Evidence. Keyed on village "Ad-Dilam".

// Owner connection — tenant tables are FORCE-RLS even for the owner, so tenant
// inserts run inside a transaction that sets app.current_org_id (see setOrg).
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() }),
});
// Supervisor connection has a cross-org read policy — used to look up the demo
// org's admin (tenant data) before we know/hold its org context.
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }),
});

async function setOrg(tx: { $executeRawUnsafe: (s: string) => Promise<number> }, orgId: string) {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${orgId}', true)`);
}

const STUDY_TITLE = "Scored Assessment — Ad-Dilam";
const VILLAGE = "Ad-Dilam";
const CALC = "seed-v1";

const DOMAINS = [
  { key: "HEALTH", name: "Health", sev: 72, perf: 28, weight: 0.3, wc: 8.4, critical: true, conf: "STANDARD", valid: 35 },
  { key: "EDUCATION", name: "Education", sev: 48, perf: 52, weight: 0.25, wc: 13.0, critical: false, conf: "STANDARD", valid: 36 },
  { key: "INFRASTRUCTURE", name: "Infrastructure", sev: 63, perf: 37, weight: 0.2, wc: 7.4, critical: false, conf: "STANDARD", valid: 34 },
  { key: "LIVELIHOOD", name: "Livelihood", sev: 55, perf: 45, weight: 0.15, wc: 6.75, critical: false, conf: "STANDARD", valid: 33 },
  { key: "WATER_SANITATION", name: "Water & Sanitation", sev: 81, perf: 19, weight: 0.1, wc: 1.9, critical: true, conf: "LOW", valid: 8 },
];
const KPIS = [
  { id: "KPI_WATER_ACCESS", name: "Daily Clean Water Access", sev: 88, conf: "LOW", valid: 8 },
  { id: "KPI_MEDICINE", name: "Availability of Essential Medicines", sev: 78, conf: "STANDARD", valid: 35 },
  { id: "KPI_HEALTH_DISTANCE", name: "Distance to Primary Health Facility", sev: 72, conf: "STANDARD", valid: 36 },
];

async function main(): Promise<void> {
  const admin = await supervisor.user.findFirst({ where: { email: "admin@demo-ngo.org" } });
  if (!admin) throw new Error("Run `pnpm prisma:seed` first (admin@demo-ngo.org not found).");
  const orgId = admin.orgId;
  const createdBy = admin.id;

  // MethodologyVersion is global reference data (no RLS).
  const mv = await prisma.methodologyVersion.findFirst({ orderBy: { createdAt: "asc" } });
  if (!mv) throw new Error("No MethodologyVersion found — run the main seed / imports first.");

  await prisma.$transaction(async (tx) => {
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
        title: "Community water & health needs",
        statement: "Assessment of water, sanitation, and health needs in Ad-Dilam.",
        source: "field_survey",
        village: [VILLAGE],
        domain: "Water & Sanitation",
        createdBy,
      },
    });

    const survey = await tx.survey.create({
      data: {
        orgId,
        needId: need.id,
        studyId: study.id,
        title: "Ad-Dilam Needs Survey",
        status: "published",
        methodologyVersion: mv.version,
        publishedAt: new Date(),
        createdBy,
      },
    });

    const link = await tx.publicSurveyLink.create({
      data: { orgId, needId: need.id, studyId: study.id, label: "Seed Link", token: randomBytes(16).toString("hex"), createdBy },
    });

    // 38 valid responses: 21 female, 17 male.
    await tx.surveyResponse.createMany({
      data: Array.from({ length: 38 }, (_, i) => ({
        orgId,
        needId: need.id,
        studyId: study.id,
        surveyLinkId: link.id,
        contact: `respondent-${i + 1}@seed.local`,
        gender: (i < 21 ? "female" : "male") as "female" | "male",
        settlementType: (i < 26 ? "rural" : "urban") as "rural" | "urban",
        village: [VILLAGE],
        answers: {},
      })),
    });

    // ── Score rollups (villageId-scoped) ──
    const common = { orgId, studyId: study.id, surveyId: survey.id, villageId: VILLAGE, methodologyVersionId: mv.id, calculationVersion: CALC };

    await tx.scoreRollup.create({
      data: {
        ...common,
        rollupLevel: "OVERALL",
        entityId: "OVERALL",
        entityNameSnapshot: "Overall",
        severityScore: 63.8,
        validResponseCount: 38,
        excludedResponseCount: 4,
        dontKnowCount: 5,
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
        dontKnowCount: d.conf === "LOW" ? 6 : 1,
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
        dontKnowCount: k.conf === "LOW" ? 6 : 1,
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
        { orgId, needId: need.id, studyId: study.id, fileName: "water-report.pdf", fileType: "application/pdf", storageKey: "seed/water-report.pdf", title: "Water shortage", sourceReferenceId: "REF-W1", linkedDomainOrKpi: "Water & Sanitation", description: "Respondents reported irregular water supply and long travel distance to collect water.", reviewStatus: "APPROVED", isIncludedInReport: true, uploadedBy: createdBy },
        { orgId, needId: need.id, studyId: study.id, fileName: "health-notes.pdf", fileType: "application/pdf", storageKey: "seed/health-notes.pdf", title: "Healthcare access", sourceReferenceId: "REF-H1", linkedDomainOrKpi: "Health", description: "Community members highlighted medicine shortages and distance to nearby health facilities.", reviewStatus: "APPROVED", isIncludedInReport: true, uploadedBy: createdBy },
      ],
    });

    // A confirmed AI summary (canned narrative) so `save-report` can be
    // exercised without calling Gemini.
    await tx.aiPrioritySummary.create({
      data: {
        orgId,
        studyId: study.id,
        surveyId: survey.id,
        villageId: VILLAGE,
        scopeFilters: { villageId: VILLAGE },
        reportDataSnapshotId: "seed-snapshot",
        status: "OFFICER_CONFIRMED",
        summaryScope: "VILLAGE",
        promptHash: "seed",
        inputReportDataHash: "seed",
        inputEvidenceSnapshotHash: "seed",
        aiOutputJson: {
          executiveSummary: `${VILLAGE} has a High Priority status driven by Water & Sanitation and Health.`,
          keyFindings: [
            { title: "Water severity", domain: "Water & Sanitation", kpi: "Access", confidence: "LOW", summary: "Water & Sanitation has the highest severity (81)." },
          ],
          dataQualityNote: "Water & Sanitation findings have Low Confidence (8 valid responses).",
          trendNote: "Cycle assessment: Trend Pending.",
          draftNextSteps: ["Validate water-access findings.", "Review medicine availability."],
        },
        generatedBy: createdBy,
        officerConfirmedBy: createdBy,
        officerConfirmedAt: new Date(),
      },
    });

    console.log(`✅ Seeded scored study "${STUDY_TITLE}" (${study.id})`);
    console.log(`   Survey ${survey.id} · village "${VILLAGE}" · 38 responses (21F/17M) · OVERALL 63.8 · priority 37.45 HIGH`);
    console.log(`   → Reports → Generate → RPT14 → "${STUDY_TITLE}" → village "${VILLAGE}" now renders REAL data.`);
  });
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
