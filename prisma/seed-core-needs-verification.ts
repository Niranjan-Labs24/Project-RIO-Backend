// Seeds ONE new, self-contained study whose single REGION-scope Core Needs Report
// (RPT18) demonstrates every client-verification rule at once, so a reviewer can
// check them in one PDF instead of nine. Al-Qassim region, six governorates:
//
//   Unayzah       meets its standard, the harshest governorate (needs index ~99)
//   Ar-Rass       meets its standard, moderate severity
//   Al-Mithnab    meets its standard, mild severity
//   Al-Bukayriyah 8 of 10 centres hold data (80%, so shown) but 8 responses
//                 against 94 required: Low, so named in ranking.excludedLow
//   Al-Badai      1 of 4 centres hold data (25% < the 80% threshold): "Not shown"
//   Buraydah      in the study, no responses: grey, never ranked
//
// Two Education KPIs are at the worst option everywhere, so the pooled region
// shows a KPI at severity 100 (Critical band). Only four of the nine domains are measured, so the other five render grey as
// "Not measured". The REGION's total valid responses fall short of the region's
// required sample (profile population is the sum of the governorates', 5,120,
// so 94 required) while the three healthy governorates each meet their own, so
// overall confidence is Low: preliminary wording and the "PRELIMINARY - NOT FIT
// TO PUBLISH" watermark both appear. Every unit has an area profile, so each
// shows an "n of N required" progress bar.
//
// NOTE: the engine ranks only when every governorate with data is shown, so a
// "Not shown" governorate (point above) suppresses ranking.order and
// excludedLow for the whole report. Set INCLUDE_NOT_SHOWN to false to see the
// ranking and the Low exclusion instead.
//
// Like the other core-needs seeds this writes ANSWERS only, never scores: run
// `POST /api/studies/:studyId/surveys/:surveyId/recalculate` for each survey
// that has responses (the summary prints the ids). Severities come from the
// PUBLISHED methodology's lookups via the real engine.
//
// Idempotent: a study with the same title is left alone; profiles are upserted.
// Existing seeded and fixture studies are never touched.
//
//   pnpm seed:core-needs-verification

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { pgSslFromEnv } from "../src/prisma/pg-ssl";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() }),
});
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }),
});

async function setOrg(tx: { $executeRawUnsafe: (s: string) => Promise<number> }, orgId: string) {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${orgId}', true)`);
}

// 4 of the 9 domains: the other five render grey as "Not measured".
const DOMAINS = ["Health", "Education", "Livelihood", "Infrastructure"];
const PER_DOMAIN = 3;
/** Education's first two questions are answered at the worst option in EVERY
 *  village: a region report pools its governorates, so a KPI reaches Critical
 *  (severity >= 80) only if most responses region-wide are at the worst option. */
const HOT_DOMAIN = "Education";
const HOT_QUESTIONS = 2;
const PROFILE_YEAR = 2022;
/** Small, so a village's required sample (23) is reachable with a few responses. */
const VILLAGE_POPULATION = 30;
const PROFILE_SOURCE = "Seed: core-needs verification";

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

/** Flip to false to drop Al-Badai (the "Not shown" governorate) and let the
 *  engine rank, because it only ranks when no governorate with data is withheld. */
const INCLUDE_NOT_SHOWN = true;

// Each governorate's required sample comes from its own profile population.
const STUDY: StudyPlan = {
  title: "Core Needs Verification — Al-Qassim",
  orgEmail: "admin@demo-ngo.org",
  population: 150,
  extraGovernorates: ["0401"], // Buraydah: in the study, no data
  governorates: [
    // Unayzah (4 centres): 24 responses against 23 required; worst option everywhere (Critical).
    { code: "0402", population: 30, villages: [1, 2, 3, 4].map((centre) => ({ centre, responses: 6, intensity: 1 })) },
    // Ar-Rass (6 centres): 24 against 23.
    { code: "0403", population: 30, villages: [1, 2, 3, 4, 5, 6].map((centre) => ({ centre, responses: 4, intensity: 0.5 })) },
    // Al-Mithnab (7 centres): 21 against 20 (population 25).
    { code: "0404", population: 25, villages: [1, 2, 3, 4, 5, 6, 7].map((centre) => ({ centre, responses: 3, intensity: 0.2 })) },
    // Al-Bukayriyah (10 centres): 8 centres covered = 80%, shown; 8 against 94 required, so Low.
    { code: "0405", population: 5000, villages: [1, 2, 3, 4, 5, 6, 7, 8].map((centre) => ({ centre, responses: 1, intensity: 0.8 })) },
    // Al-Badai (4 centres): 1 centre covered = 25%, below the 80% threshold.
    ...(INCLUDE_NOT_SHOWN ? [{ code: "0406", population: 30, villages: [{ centre: 1, responses: 5, intensity: 0.6 }] }] : []),
  ],
};

/** Deterministic: the same inputs give the same report, so a diff is meaningful. */
function pickIndex(intensity: number, responseIndex: number, questionIndex: number, length: number): number {
  if (intensity >= 1) return length - 1; // no wobble: always the worst option
  const wobble = (((responseIndex * 7 + questionIndex * 3) % 5) - 2) * 0.1;
  const frac = Math.min(1, Math.max(0, intensity + wobble));
  return Math.round(frac * (length - 1));
}

const villageName = (govName: string, n: number) => `${govName} Village ${n}`;

/** The profile card prints growth, density, sex split, Saudi share and rural
 *  share next to the population. They are entered annually per unit, not
 *  derived from the survey, so the seed has to supply them or the card shows
 *  dashes. Spread deterministically from the unit key: every unit gets its own
 *  plausible figures and the same seed run twice gives the same report. */
function demographics(unitKey: string) {
  let h = 0;
  for (const ch of unitKey) h = (h * 31 + ch.charCodeAt(0)) % 1000;
  const r = (lo: number, hi: number, salt: number, dp = 1) => {
    const v = lo + (((h + salt * 97) % 1000) / 1000) * (hi - lo);
    return Number(v.toFixed(dp));
  };
  const malePct = r(49, 54, 3, 1);
  return {
    growthRatePct: r(0.8, 3.2, 1, 1),
    densityPerKm2: r(5, 60, 2, 1),
    malePct,
    femalePct: Number((100 - malePct).toFixed(1)),
    saudiPct: r(62, 88, 4, 1),
    ruralPct: r(18, 72, 5, 1),
  };
}

async function upsertProfile(
  p: { unitKey: string; level: string; regionId?: string | null; governorateId?: string | null; centerId?: string | null; villageName?: string | null; population: number },
) {
  const d = demographics(p.unitKey);
  const data = {
    level: p.level,
    regionId: p.regionId ?? null,
    governorateId: p.governorateId ?? null,
    centerId: p.centerId ?? null,
    villageName: p.villageName ?? null,
    population: p.population,
    ...d,
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
  const hotIds = new Set(chosen.filter((q) => q.domain === HOT_DOMAIN).slice(0, HOT_QUESTIONS).map((q) => q.questionId));

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
      console.log(`   study ${study.id} · org ${orgId} · population ${plan.population} (each unit judged on its own profile)`);
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
              answers[sqId] = opts[hotIds.has(questionId) ? opts.length - 1 : pickIndex(vp.intensity, ri, qi, opts.length)]!.id;
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

/** Population by unit. The region is the sum of its governorates, so its
 *  required sample is one the healthy governorates together cannot meet. */
async function seedProfiles(): Promise<void> {
  const plans = STUDY.governorates;
  const gov = await prisma.governorate.findMany({ where: { code: { in: plans.map((g) => g.code) } } });
  const byCode = new Map(gov.map((g) => [g.code, g]));
  const regionPop = new Map<string, number>();
  for (const gp of plans) {
    const g = byCode.get(gp.code);
    if (!g) throw new Error(`Governorate ${gp.code} not found — run the geography import.`);
    regionPop.set(g.regionId, (regionPop.get(g.regionId) ?? 0) + gp.population);
    await upsertProfile({ unitKey: `GOVERNORATE:${g.id}`, level: "GOVERNORATE", regionId: g.regionId, governorateId: g.id, population: gp.population });
    // Villages are free text, keyed by governorate and lower-cased name.
    for (const [vi] of gp.villages.entries()) {
      const name = villageName(g.name, vi + 1);
      await upsertProfile({
        unitKey: `VILLAGE:${g.id}:${name.toLowerCase()}`, level: "VILLAGE", regionId: g.regionId, governorateId: g.id, villageName: name, population: VILLAGE_POPULATION,
      });
    }
  }
  for (const [rid, pop] of regionPop) await upsertProfile({ unitKey: `REGION:${rid}`, level: "REGION", regionId: rid, population: pop });
}

async function main(): Promise<void> {
  await seedProfiles();
  const mv = await prisma.methodologyVersion.findFirst({ where: { status: "PUBLISHED" } });
  if (!mv) throw new Error("No PUBLISHED MethodologyVersion — run `pnpm import:methodology -- --publish`.");
  await seedStudy(STUDY, mv);
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
