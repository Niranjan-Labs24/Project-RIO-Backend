import "dotenv/config";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { pgSslFromEnv } from "../src/prisma/pg-ssl";

// Dev helper: score an EXISTING study (by title) so its reports render real data.
// Creates survey responses (with gender + settlement), score rollups (OVERALL +
// DOMAIN + KPI) and a VillagePriorityAssessment, keyed on the study's need's
// village. Does NOT seed an AI summary, so report generation calls real Gemini.
//
//   pnpm score:study "Resource of water"

const CALC = "dev-score-v1";
const DOMAINS = [
  { key: "WATER_SANITATION", name: "Water & Sanitation", sev: 85, perf: 15, weight: 0.3, wc: 4.5, critical: true, conf: "LOW", valid: 9 },
  { key: "HEALTH", name: "Health", sev: 70, perf: 30, weight: 0.25, wc: 7.5, critical: true, conf: "STANDARD", valid: 34 },
  { key: "INFRASTRUCTURE", name: "Infrastructure", sev: 58, perf: 42, weight: 0.2, wc: 8.4, critical: false, conf: "STANDARD", valid: 33 },
  { key: "LIVELIHOOD", name: "Livelihood", sev: 50, perf: 50, weight: 0.15, wc: 7.5, critical: false, conf: "STANDARD", valid: 32 },
  { key: "EDUCATION", name: "Education", sev: 44, perf: 56, weight: 0.1, wc: 5.6, critical: false, conf: "STANDARD", valid: 35 },
];
const KPIS = [
  { id: "KPI_CLEAN_WATER", name: "Daily Clean Water Access", sev: 90, conf: "LOW", valid: 9 },
  { id: "KPI_WATER_QUALITY", name: "Drinking Water Quality / Salinity", sev: 84, conf: "STANDARD", valid: 33 },
  { id: "KPI_WATER_DISTANCE", name: "Distance to Water Source", sev: 79, conf: "STANDARD", valid: 34 },
];
const OVERALL = 68.0;
const PRIORITY = 41.5;

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() }) });
const supervisor = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }) });
const setOrg = (tx: { $executeRawUnsafe: (s: string) => Promise<number> }, orgId: string) =>
  tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${orgId}', true)`);

async function main(): Promise<void> {
  const title = process.argv[2] || "Resource of water";
  const study = await supervisor.study.findFirst({ where: { title } });
  if (!study) throw new Error(`Study "${title}" not found.`);
  const orgId = study.orgId;
  const admin = await supervisor.user.findFirst({ where: { orgId } });
  const createdBy = admin!.id;

  // Resolve a REAL published methodology version. Studies created in the UI can
  // carry a placeholder version string that matches no real MethodologyVersion,
  // which makes the dashboard/scoring resolve nothing — so we also realign the
  // survey's version below to this one.
  const mv =
    (await prisma.methodologyVersion.findFirst({ where: { status: "PUBLISHED" }, orderBy: { createdAt: "asc" } })) ??
    (await prisma.methodologyVersion.findFirst({ orderBy: { createdAt: "asc" } }));
  if (!mv) throw new Error("No MethodologyVersion found.");

  await prisma.$transaction(async (tx) => {
    await setOrg(tx, orgId);

    const need = await tx.need.findFirst({ where: { studyId: study.id } });
    if (!need) throw new Error(`Study "${title}" has no Need — add one (with a village) first.`);
    const village = need.village[0];
    if (!village) throw new Error(`Need has no village — set one on the Need first.`);

    let survey = await tx.survey.findFirst({ where: { studyId: study.id }, orderBy: { createdAt: "desc" } });
    if (!survey) {
      survey = await tx.survey.create({
        data: { orgId, needId: need.id, studyId: study.id, title: `${title} Survey`, status: "published", methodologyVersion: mv.version, publishedAt: new Date(), createdBy },
      });
    } else if (survey.methodologyVersion !== mv.version) {
      // Realign a placeholder/mismatched version so the dashboard & scoring
      // resolve the SAME methodology version these rollups are keyed on.
      survey = await tx.survey.update({ where: { id: survey.id }, data: { methodologyVersion: mv.version } });
    }

    let link = await tx.publicSurveyLink.findFirst({ where: { needId: need.id } });
    if (!link) {
      link = await tx.publicSurveyLink.create({
        data: { orgId, needId: need.id, studyId: study.id, label: "Score Link", token: randomBytes(16).toString("hex"), createdBy },
      });
    }

    // Top up to ~38 responses with gender (21F/17M) + settlement (26 rural / 12 urban).
    const existing = await tx.surveyResponse.count({ where: { needId: need.id } });
    const toAdd = Math.max(0, 38 - existing);
    if (toAdd > 0) {
      await tx.surveyResponse.createMany({
        data: Array.from({ length: toAdd }, (_, i) => ({
          orgId, needId: need.id, studyId: study.id, surveyLinkId: link!.id,
          contact: `score-${Date.now()}-${i}@dev.local`,
          gender: (i % 38 < 21 ? "female" : "male") as "female" | "male",
          settlementType: (i % 38 < 26 ? "rural" : "urban") as "rural" | "urban",
          village: [village], answers: {},
        })),
      });
    }

    // Idempotent: clear any prior rollups/assessment for this study+survey.
    await tx.scoreRollup.deleteMany({ where: { studyId: study.id, surveyId: survey.id } });
    await tx.villagePriorityAssessment.deleteMany({ where: { studyId: study.id, surveyId: survey.id } });

    // Seed both the governorate/village-keyed rows AND the consolidated ('')
    // rows, since different dashboard tabs query one or the other.
    const villageKeys = village ? [village, ""] : [""];
    for (const vk of villageKeys) {
      const common = { orgId, studyId: study.id, surveyId: survey.id, villageId: vk, methodologyVersionId: mv.id, calculationVersion: CALC };
      await tx.scoreRollup.create({
        data: { ...common, rollupLevel: "OVERALL", entityId: "OVERALL", entityNameSnapshot: "Overall", severityScore: OVERALL, validResponseCount: 38, excludedResponseCount: 3, dontKnowCount: 4, dontKnowRate: 0.105, notApplicableCount: 0, confidenceLevel: "STANDARD" },
      });
      await tx.scoreRollup.createMany({
        data: DOMAINS.map((d) => ({ ...common, rollupLevel: "DOMAIN", entityId: d.key, entityNameSnapshot: d.name, severityScore: d.sev, validResponseCount: d.valid, excludedResponseCount: 0, dontKnowCount: d.conf === "LOW" ? 6 : 1, dontKnowRate: d.conf === "LOW" ? 0.25 : 0.05, notApplicableCount: 0, confidenceLevel: d.conf })),
      });
      await tx.scoreRollup.createMany({
        data: KPIS.map((k) => ({ ...common, rollupLevel: "KPI", entityId: k.id, entityNameSnapshot: k.name, severityScore: k.sev, validResponseCount: k.valid, excludedResponseCount: 0, dontKnowCount: k.conf === "LOW" ? 6 : 1, dontKnowRate: k.conf === "LOW" ? 0.25 : 0.05, notApplicableCount: 0, confidenceLevel: k.conf })),
      });
      await tx.villagePriorityAssessment.create({
        data: {
          ...common,
          priorityScore: PRIORITY,
          priorityStatus: "HIGH",
          overrideApplied: true,
          overrideReason: "Critical Domain Override: Water & Sanitation performance score is 15, below the threshold of 30.",
          domainComponents: DOMAINS.map((d) => ({ domainKey: d.key, domainNameSnapshot: d.name, domainSeverityScore: d.sev, domainPerformanceScore: d.perf, domainWeight: d.weight, weightedContribution: d.wc, isCriticalDomain: d.critical, criticalThreshold: 30, triggeredOverride: d.key === "WATER_SANITATION" })),
        },
      });
    }

    console.log(`✅ Scored "${title}" · village "${village}" · survey ${survey.id}`);
    console.log(`   OVERALL ${OVERALL} · priority ${PRIORITY} HIGH · Water & Sanitation severity 85 (critical override)`);
    console.log(`   → Reports → Generate → RPT14 → "${title}" → village "${village}" now renders REAL data + real Gemini AI summary.`);
  });
}

main()
  .then(() => Promise.all([prisma.$disconnect(), supervisor.$disconnect()]))
  .catch(async (e) => {
    console.error(e.message ?? e);
    await Promise.all([prisma.$disconnect(), supervisor.$disconnect()]);
    process.exit(1);
  });
