// Seeds NEW, self-contained studies that exercise the Core Needs Report (RPT18)
// rules that need MORE THAN ONE village, governorate, region or organisation:
//
//   T3  Region export     — Riyadh region with four governorates holding data
//                           plus two in the study that hold none (grey).
//   T4  Mixed confidence  — three governorates meet the standard, one (Al-Hariq)
//                           is Low on sample size, so the ranking names it as
//                           excluded rather than ranking it. Units without data
//                           are never ranked.
//   T5  Partial coverage  — Badr (Madinah) names five villages in five centres
//                           but only three hold responses, and only 3 of its 8
//                           centres hold data; Wadi Al-Fara' covers 7 of 8. At
//                           region scope the governorate score is withheld below
//                           the approved share of centres; at governorate scope
//                           the child centres show instead.
//   T9  NCNP              — a SECOND organisation (Riverside Community Trust)
//                           with its own study over the same region, so the
//                           pooled score, each study's share and its own
//                           reliability are all visible.
//   T10 Scope levels      — one dataset, exported at Kingdom, region,
//                           governorate and centre level.
//
// Like seed-core-needs.ts this writes ANSWERS only, never scores: run
// `POST /api/studies/:studyId/surveys/:surveyId/recalculate` for each survey
// that has responses (the summary prints the ids). Answer options are chosen
// from the PUBLISHED methodology's lookups, so severities come from the real
// engine. All four domains and twelve questions are shared by every village,
// which is what makes the units comparable on the same domains.
//
// Area profiles (population) are written too: they drive each unit's required
// sample and the per-unit progress bar. Populations are small on purpose, so a
// handful of responses meets the standard; Al-Hariq's is large, so it does not.
//
// Idempotent: a study with the same title is left alone; profiles are upserted.
// The existing seeded and fixture studies are never touched.
//
//   pnpm seed:core-needs-geography

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { pgSslFromEnv } from "../src/prisma/pg-ssl";
import { calculateSampleSize } from "../src/modules/studies/sample-size";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() }),
});
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }),
});

async function setOrg(tx: { $executeRawUnsafe: (s: string) => Promise<number> }, orgId: string) {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${orgId}', true)`);
}

const DOMAINS = ["Health", "Education", "Livelihood", "Infrastructure"];
const PER_DOMAIN = 3;
const PROFILE_YEAR = 2022;
/** Small, so a village's required sample (23) is reachable with a few responses. */
const VILLAGE_POPULATION = 30;
const PROFILE_SOURCE = "Seed: core-needs geography";

/** One village = one need + one survey, in one centre of one governorate. */
interface VillagePlan {
  /** 1-based index of the centre within the governorate (by centre code). */
  centre: number;
  /** Responses given; 0 names the village without any data. */
  responses: number;
  /** 0 = least severe answers, 1 = most severe. */
  intensity: number;
}
interface GovPlan {
  code: string; // governorate code, e.g. "0102"
  /** Population entered for the governorate's area profile. */
  population: number;
  villages: VillagePlan[];
}
interface StudyPlan {
  title: string;
  orgEmail: string;
  population: number;
  /** Governorates the study covers; those without a plan stay empty (grey). */
  extraGovernorates: string[];
  governorates: GovPlan[];
}

// Study A (Demo NGO): Riyadh region (T3/T4) and Madinah (T5), so Kingdom shows two of 13 regions.
const STUDY_A: StudyPlan = {
  title: "Core Needs Geography — Riyadh and Madinah",
  orgEmail: "admin@demo-ngo.org",
  population: 150,
  extraGovernorates: ["0116", "0121"], // Rumah, Marat: in the study, no data
  governorates: [
    // Meets the standard: 36 responses against 28 required.
    { code: "0102", population: 40, villages: [1, 2, 3, 4, 5, 6].map((centre) => ({ centre, responses: 6, intensity: 0.8 })) },
    { code: "0120", population: 40, villages: [1, 2, 3].map((centre) => ({ centre, responses: 10, intensity: 0.5 })) },
    { code: "0109", population: 40, villages: [1, 2, 3, 4, 5].map((centre) => ({ centre, responses: 7, intensity: 0.3 })) },
    // Low: 12 responses against 94 required (population 5,000).
    { code: "0119", population: 5000, villages: [1, 2, 3, 4].map((centre) => ({ centre, responses: 3, intensity: 0.9 })) },
    // Badr: 5 villages named, 3 with data, 3 of 8 centres covered.
    {
      code: "0305",
      population: 40,
      villages: [
        { centre: 1, responses: 14, intensity: 0.6 },
        { centre: 2, responses: 14, intensity: 0.6 },
        { centre: 3, responses: 14, intensity: 0.6 },
        { centre: 4, responses: 0, intensity: 0 },
        { centre: 5, responses: 0, intensity: 0 },
      ],
    },
    // Wadi Al-Fara': 7 of 8 centres covered.
    { code: "0308", population: 40, villages: [1, 2, 3, 4, 5, 6, 7].map((centre) => ({ centre, responses: 5, intensity: 0.2 })) },
  ],
};

// Study B (Riverside Community Trust): overlaps Study A in Ad-Diriyah (village
// 1, same name, so it is one village across studies) and Az-Zulfi, and adds Marat.
const STUDY_B: StudyPlan = {
  title: "Riyadh Region Needs — Riverside Community Trust",
  orgEmail: "admin@riverside-ngo.org",
  population: 80,
  extraGovernorates: [],
  governorates: [
    { code: "0102", population: 40, villages: [{ centre: 1, responses: 10, intensity: 0.4 }] },
    { code: "0121", population: 40, villages: [{ centre: 1, responses: 10, intensity: 0.7 }] },
    { code: "0109", population: 40, villages: [{ centre: 1, responses: 20, intensity: 0.5 }] },
  ],
};

/** Deterministic: the same inputs give the same report, so a diff is meaningful. */
function pickIndex(intensity: number, responseIndex: number, questionIndex: number, length: number): number {
  const wobble = (((responseIndex * 7 + questionIndex * 3) % 5) - 2) * 0.1;
  const frac = Math.min(1, Math.max(0, intensity + wobble));
  return Math.round(frac * (length - 1));
}

const villageName = (govName: string, n: number) => `${govName} Village ${n}`;

async function upsertProfile(
  p: { unitKey: string; level: string; regionId?: string | null; governorateId?: string | null; centerId?: string | null; villageName?: string | null; population: number },
) {
  const data = {
    level: p.level,
    regionId: p.regionId ?? null,
    governorateId: p.governorateId ?? null,
    centerId: p.centerId ?? null,
    villageName: p.villageName ?? null,
    population: p.population,
    source: PROFILE_SOURCE,
  };
  await prisma.areaProfile.upsert({
    where: { unitKey_year: { unitKey: p.unitKey, year: PROFILE_YEAR } },
    create: { unitKey: p.unitKey, year: PROFILE_YEAR, ...data },
    update: data,
  });
}

async function seedStudy(plan: StudyPlan, mv: { id: string; version: string }): Promise<void> {
  const user = await supervisor.user.findFirst({ where: { email: plan.orgEmail } });
  if (!user) throw new Error(`User ${plan.orgEmail} not found.`);
  const orgId = user.orgId;

  const lookups = await prisma.scoringLookup.findMany({
    where: { methodologyVersionId: mv.id, isActive: true, lookupType: "OPTION", isExcluded: false },
    select: { questionId: true, optionId: true, severityScore: true },
  });
  const optionsByQuestion = new Map<string, Array<{ id: string; sev: number }>>();
  for (const l of lookups) {
    if (!l.optionId || l.severityScore === null) continue;
    const list = optionsByQuestion.get(l.questionId) ?? [];
    list.push({ id: l.optionId, sev: Number(l.severityScore) });
    optionsByQuestion.set(l.questionId, list);
  }
  for (const list of optionsByQuestion.values()) list.sort((a, b) => a.sev - b.sev);

  const questions = await prisma.question.findMany({
    where: { methodologyVersionId: mv.id, measurementMode: "SINGLE_SELECT", domain: { in: DOMAINS }, isActive: true },
    select: { id: true, questionId: true, domain: true },
    orderBy: { questionId: "asc" },
  });
  const chosen = DOMAINS.flatMap((d) =>
    questions.filter((q) => q.domain === d && (optionsByQuestion.get(q.questionId)?.length ?? 0) >= 2).slice(0, PER_DOMAIN),
  );
  if (chosen.length === 0) throw new Error("No scoreable questions found.");

  // Geography: governorates by code, with their centres in code order.
  const codes = [...new Set([...plan.governorates.map((g) => g.code), ...plan.extraGovernorates])];
  const govRows = await prisma.governorate.findMany({
    where: { code: { in: codes } },
    include: { centers: { orderBy: { code: "asc" } } },
  });
  const govByCode = new Map(govRows.map((g) => [g.code, g]));
  for (const c of codes) if (!govByCode.has(c)) throw new Error(`Governorate ${c} not found — run the geography import.`);

  await prisma.$transaction(
    async (tx) => {
      await setOrg(tx, orgId);
      const existing = await tx.study.findFirst({ where: { orgId, title: plan.title } });
      if (existing) {
        console.log(`[${plan.title}] already seeded: study ${existing.id}. Nothing to do.`);
        return;
      }
      const maxCycle = await tx.study.aggregate({ where: { orgId }, _max: { cycleNumber: true } });
      const sample = calculateSampleSize(plan.population);
      const allVillages = plan.governorates.flatMap((gp) => gp.villages.map((_, i) => villageName(govByCode.get(gp.code)!.name, i + 1)));
      const study = await tx.study.create({
        data: {
          orgId, title: plan.title, villages: allVillages, cycleNumber: (maxCycle._max.cycleNumber ?? 0) + 1,
          methodologyVersionId: mv.id, createdBy: user.id, population: plan.population,
          // No requiredSampleSize: each unit derives its own from its area profile,
          // so a village, centre or governorate is judged against its own population.
        },
      });
      for (const code of codes) {
        await tx.studyGovernorate.create({ data: { studyId: study.id, orgId, governorateId: govByCode.get(code)!.id } });
      }

      console.log(`✅ ${plan.title}`);
      console.log(`   study ${study.id} · org ${orgId} · population ${plan.population} (pooled required sample ${sample.requiredSampleSize})`);
      for (const gp of plan.governorates) {
        const g = govByCode.get(gp.code)!;
        const regionId = g.regionId;
        for (const [vi, vp] of gp.villages.entries()) {
          const centre = g.centers[vp.centre - 1];
          if (!centre) throw new Error(`${g.name} has no centre #${vp.centre}.`);
          const name = villageName(g.name, vi + 1);
          const code = `${gp.code}-${vi + 1}`;

          const need = await tx.need.create({
            data: {
              orgId, studyId: study.id, title: `${name} needs`, statement: `Geography fixture for the Core Needs Report in ${name}.`,
              source: "field_survey", village: [name], domain: DOMAINS[0]!, subDomain: "Fixture", createdBy: user.id,
            },
          });
          await tx.needDomain.create({ data: { needId: need.id, orgId, domain: DOMAINS[0]!, subDomain: "Fixture" } });
          await tx.needGovernorate.create({ data: { needId: need.id, orgId, governorateId: g.id } });
          await tx.needCenter.create({ data: { needId: need.id, orgId, centerId: centre.id } });

          const survey = await tx.survey.create({
            data: {
              orgId, needId: need.id, studyId: study.id, title: `${name} Needs Survey`, status: "PUBLISHED",
              methodologyVersion: mv.version, publishedAt: new Date(), approverComments: "System-generated seed data", createdBy: user.id,
            },
          });
          const link = await tx.publicSurveyLink.create({
            data: { orgId, needId: need.id, studyId: study.id, label: "Seed Link", token: randomBytes(16).toString("hex"), createdBy: user.id },
          });
          const sqs: Array<{ sqId: string; questionId: string }> = [];
          let order = 1;
          for (const q of chosen) {
            const sq = await tx.surveyQuestion.create({
              data: { surveyId: survey.id, questionId: q.id, order: order++, isRequired: true }, select: { id: true },
            });
            sqs.push({ sqId: sq.id, questionId: q.questionId });
          }

          const rows = Array.from({ length: vp.responses }, (_, ri) => {
            const answers: Record<string, string> = {};
            sqs.forEach(({ sqId, questionId }, qi) => {
              const opts = optionsByQuestion.get(questionId)!;
              answers[sqId] = opts[pickIndex(vp.intensity, ri, qi, opts.length)]!.id;
            });
            return {
              orgId, needId: need.id, studyId: study.id, surveyLinkId: link.id,
              contact: `${code}-respondent-${ri + 1}@seed.local`,
              gender: (ri % 2 === 0 ? "female" : "male") as "female" | "male",
              settlementType: "rural" as const, village: [name], regionId, governorateIds: [g.id], centerIds: [centre.id], answers,
            };
          });
          if (rows.length) await tx.surveyResponse.createMany({ data: rows });
          console.log(
            `   ${g.name} / ${centre.name} / ${name}: ${vp.responses} responses  survey ${survey.id}${vp.responses ? "  (recalculate)" : "  (no data)"}`,
          );
        }
      }
      console.log(`   → POST /api/studies/${study.id}/surveys/<surveyId>/recalculate for each survey marked (recalculate).`);
    },
    { timeout: 300_000 },
  );
}

/** Population by unit, from both studies' governorates. Written once, together,
 *  so a region or the Kingdom is the sum of every governorate entered and one
 *  study's run never overwrites the figures the other relies on. */
async function seedProfiles(): Promise<void> {
  const plans = [...STUDY_A.governorates, ...STUDY_B.governorates];
  const gov = await prisma.governorate.findMany({ where: { code: { in: [...new Set(plans.map((g) => g.code))] } } });
  const byCode = new Map(gov.map((g) => [g.code, g]));
  const popByCode = new Map(plans.map((g) => [g.code, g.population]));
  const regionPop = new Map<string, number>();
  for (const [code, pop] of popByCode) {
    const g = byCode.get(code);
    if (!g) throw new Error(`Governorate ${code} not found — run the geography import.`);
    regionPop.set(g.regionId, (regionPop.get(g.regionId) ?? 0) + pop);
    await upsertProfile({ unitKey: `GOVERNORATE:${g.id}`, level: "GOVERNORATE", regionId: g.regionId, governorateId: g.id, population: pop });
  }
  for (const [rid, pop] of regionPop) await upsertProfile({ unitKey: `REGION:${rid}`, level: "REGION", regionId: rid, population: pop });
  // Villages are free text, keyed by governorate and lower-cased name.
  for (const plan of [STUDY_A, STUDY_B]) {
    for (const gp of plan.governorates) {
      const g = byCode.get(gp.code)!;
      for (const [vi] of gp.villages.entries()) {
        const name = villageName(g.name, vi + 1);
        await upsertProfile({
          unitKey: `VILLAGE:${g.id}:${name.toLowerCase()}`, level: "VILLAGE", regionId: g.regionId, governorateId: g.id, villageName: name, population: VILLAGE_POPULATION,
        });
      }
    }
  }
  await upsertProfile({ unitKey: "KINGDOM", level: "KINGDOM", population: [...regionPop.values()].reduce((a, b) => a + b, 0) });
}

/** Riverside has only an admin, who cannot run scoring; give it a data analyst
 *  (same role and password as analyst@demo-ngo.org) so its study can be scored. */
async function ensureRiversideAnalyst(): Promise<void> {
  const admin = await supervisor.user.findFirst({ where: { email: "admin@riverside-ngo.org" } });
  const model = await supervisor.user.findFirst({ where: { email: "analyst@demo-ngo.org" } });
  if (!admin || !model?.passwordHash) throw new Error("admin@riverside-ngo.org or analyst@demo-ngo.org not found.");
  await prisma.$transaction(async (tx) => {
    await setOrg(tx, admin.orgId);
    const data = { orgId: admin.orgId, name: "Riverside Data Analyst", roleId: model.roleId, status: model.status, passwordHash: model.passwordHash, consentedAt: new Date() };
    await tx.user.upsert({ where: { email: "analyst@riverside-ngo.org" }, update: data, create: { email: "analyst@riverside-ngo.org", ...data } });
  });
}

async function main(): Promise<void> {
  await ensureRiversideAnalyst();
  await seedProfiles();
  const mv = await prisma.methodologyVersion.findFirst({ where: { status: "PUBLISHED" } });
  if (!mv) throw new Error("No PUBLISHED MethodologyVersion — run `pnpm import:methodology -- --publish`.");
  await seedStudy(STUDY_A, mv);
  await seedStudy(STUDY_B, mv);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await supervisor.$disconnect();
  });
