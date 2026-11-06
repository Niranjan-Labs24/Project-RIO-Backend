// Seeds two NEW, self-contained studies that exercise Core Needs Report (RPT18)
// rules the existing "Scored Assessment — Ad-Dilam" data cannot demonstrate:
//
//   T6  Critical band     — a KPI at severity >= 80 in a NON-Health / NON-Water
//                           domain (Education). Confirmed rule: Critical is
//                           severity >= 80 with no domain restriction.
//   T7  Unmeasured domains — a study covering only 3 of the 9 domains, so the
//                           other six render grey with their "not measured" reason.
//
// Like seed-core-needs.ts this writes ANSWERS only, never scores: run
// `POST /api/studies/:studyId/surveys/:surveyId/recalculate` afterwards so the
// real engine derives severities from the PUBLISHED methodology's lookups. The
// answer options are chosen from those lookups to land on the severities needed.
//
// Idempotent: a study with the same title is left alone. The existing seeded
// study is never touched.
//
//   pnpm seed:core-needs-fixtures

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

const RESPONSES = 40;
const PER_DOMAIN = 4;

interface Fixture {
  code: "T6" | "T7";
  title: string;
  village: string;
  /** Only these domains get questions; the rest stay unmeasured. */
  domains: string[];
  /** Domain -> how many of its first questions are answered at max severity. */
  hotQuestions: Record<string, number>;
}

const FIXTURES: Fixture[] = [
  {
    code: "T6",
    title: "Critical Band Test — Al-Qasr",
    village: "Al-Qasr",
    domains: ["Education", "Culture", "Livelihood"],
    // Education (not Health / Water & Sanitation) gets two KPIs at severity 100.
    hotQuestions: { Education: 2 },
  },
  {
    code: "T7",
    title: "Unmeasured Domains Test — Ar-Rawda",
    village: "Ar-Rawda",
    // 3 of 9 domains measured, moderate severities only.
    domains: ["Health", "Education", "Infrastructure"],
    hotQuestions: {},
  },
];

async function seedFixture(f: Fixture, ctx: { orgId: string; createdBy: string; regionId: string | null; mvId: string; mvVersion: string }) {
  const lookups = await prisma.scoringLookup.findMany({
    where: { methodologyVersionId: ctx.mvId, isActive: true, lookupType: "OPTION", isExcluded: false },
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
    where: { methodologyVersionId: ctx.mvId, measurementMode: "SINGLE_SELECT", domain: { in: f.domains }, isActive: true },
    select: { id: true, questionId: true, domain: true },
    orderBy: { questionId: "asc" },
  });
  const chosen: Array<{ id: string; questionId: string; domain: string; hot: boolean }> = [];
  for (const domain of f.domains) {
    const inDomain = questions.filter((q) => q.domain === domain && (optionsByQuestion.get(q.questionId)?.length ?? 0) >= 2).slice(0, PER_DOMAIN);
    const hotN = f.hotQuestions[domain] ?? 0;
    inDomain.forEach((q, i) => chosen.push({ ...q, hot: i < hotN }));
  }
  if (chosen.length === 0) throw new Error(`${f.code}: no scoreable questions found.`);

  await prisma.$transaction(
    async (tx) => {
      await setOrg(tx, ctx.orgId);
      const existing = await tx.study.findFirst({ where: { orgId: ctx.orgId, title: f.title } });
      if (existing) {
        const sv = await tx.survey.findFirst({ where: { studyId: existing.id } });
        console.log(`[${f.code}] already seeded: study ${existing.id} survey ${sv?.id}. Nothing to do.`);
        return;
      }
      const maxCycle = await tx.study.aggregate({ where: { orgId: ctx.orgId }, _max: { cycleNumber: true } });
      const study = await tx.study.create({
        data: {
          orgId: ctx.orgId, title: f.title, villages: [f.village],
          cycleNumber: (maxCycle._max.cycleNumber ?? 0) + 1, methodologyVersionId: ctx.mvId, createdBy: ctx.createdBy,
        },
      });
      const need = await tx.need.create({
        data: {
          orgId: ctx.orgId, studyId: study.id, title: `${f.code} fixture needs`,
          statement: `Fixture for Core Needs Report rule ${f.code} in ${f.village}.`,
          source: "field_survey", village: [f.village], domain: f.domains[0]!, subDomain: "Fixture", createdBy: ctx.createdBy,
        },
      });
      await tx.needDomain.create({ data: { needId: need.id, orgId: ctx.orgId, domain: f.domains[0]!, subDomain: "Fixture" } });

      const survey = await tx.survey.create({
        data: {
          orgId: ctx.orgId, needId: need.id, studyId: study.id, title: `${f.village} Needs Survey`, status: "PUBLISHED",
          methodologyVersion: ctx.mvVersion, publishedAt: new Date(), approverComments: "System-generated seed data", createdBy: ctx.createdBy,
        },
      });
      const link = await tx.publicSurveyLink.create({
        data: { orgId: ctx.orgId, needId: need.id, studyId: study.id, label: "Seed Link", token: randomBytes(16).toString("hex"), createdBy: ctx.createdBy },
      });

      const sqs: Array<{ sqId: string; q: (typeof chosen)[number] }> = [];
      let order = 1;
      for (const q of chosen) {
        const sq = await tx.surveyQuestion.create({
          data: { surveyId: survey.id, questionId: q.id, order: order++, isRequired: true }, select: { id: true },
        });
        sqs.push({ sqId: sq.id, q });
      }

      const rows = Array.from({ length: RESPONSES }, (_, ri) => {
        const answers: Record<string, string> = {};
        sqs.forEach(({ sqId, q }, qi) => {
          const opts = optionsByQuestion.get(q.questionId)!;
          // Hot: always the most severe option. Otherwise the lowest option for
          // most respondents and the middle one for the rest, so non-hot KPIs
          // stay well below Critical.
          answers[sqId] = q.hot ? opts[opts.length - 1]!.id : (ri + qi) % 3 === 0 ? opts[Math.floor((opts.length - 1) / 2)]!.id : opts[0]!.id;
        });
        return {
          orgId: ctx.orgId, needId: need.id, studyId: study.id, surveyLinkId: link.id,
          contact: `${f.code.toLowerCase()}-respondent-${ri + 1}@seed.local`,
          gender: (ri % 2 === 0 ? "female" : "male") as "female" | "male",
          settlementType: "rural" as const, village: [f.village], regionId: ctx.regionId, answers,
        };
      });
      await tx.surveyResponse.createMany({ data: rows });

      console.log(`✅ [${f.code}] ${f.title}`);
      console.log(`   domains measured: ${f.domains.join(", ")} (${chosen.length} questions, ${chosen.filter((c) => c.hot).length} at max severity)`);
      console.log(`   ${RESPONSES} responses · methodology ${ctx.mvVersion} · village "${f.village}"`);
      console.log(`   study  ${study.id}`);
      console.log(`   survey ${survey.id}`);
      console.log(`   → POST /api/studies/${study.id}/surveys/${survey.id}/recalculate, then generate RPT18 (scopeLevel VILLAGE, unitId "${f.village}").`);
    },
    { timeout: 120_000 },
  );
}

async function main(): Promise<void> {
  const admin = await supervisor.user.findFirst({ where: { email: "admin@demo-ngo.org" } });
  if (!admin) throw new Error("Run `pnpm prisma:seed` first (admin@demo-ngo.org not found).");
  const org = await supervisor.organisation.findUnique({ where: { id: admin.orgId }, select: { regionId: true } });
  const mv = await prisma.methodologyVersion.findFirst({ where: { status: "PUBLISHED" } });
  if (!mv) throw new Error("No PUBLISHED MethodologyVersion — run `pnpm import:methodology -- --publish`.");
  for (const f of FIXTURES) {
    await seedFixture(f, { orgId: admin.orgId, createdBy: admin.id, regionId: org?.regionId ?? null, mvId: mv.id, mvVersion: mv.version });
  }
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
