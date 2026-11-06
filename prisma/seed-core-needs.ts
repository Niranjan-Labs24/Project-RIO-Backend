// Seeds the per-question answer data the Core Needs Report (RPT18) needs.
//
// `seed-scored-study.ts` predates RPT18: it writes ScoreRollups directly, which
// the older rollup-reading reports (RPT14 etc.) are happy with. RPT18 instead
// reads ResponseSeverityScore — one row per response per question — and those
// only exist once the real scoring engine has run over actual answers. A study
// seeded the old way therefore fails with STUDY_NOT_SCORED even though it looks
// scored.
//
// This fills the gap, and only the gap: it links the seeded survey to real
// Question Bank questions and gives every existing response an answer to each.
// It deliberately does NOT write scores — `POST /api/studies/:studyId/surveys/
// :surveyId/recalculate` does that, so the numbers come from the real engine
// and its lookups rather than from this file.
//
// Idempotent: re-running replaces this survey's questions and rewrites answers.
//
//   pnpm seed:core-needs
//   then POST .../recalculate, then generate RPT18.

import "dotenv/config";
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

const STUDY_TITLE = "Scored Assessment — Ad-Dilam";
/** Questions per domain. Enough domains for the report's domain table and
 *  hierarchy to have something to show, without answering all 193. */
const PER_DOMAIN = 3;

/** Deterministic, so a re-run produces the same report and a diff is meaningful. */
function pick<T>(options: T[], responseIndex: number, questionIndex: number): T {
  // A spread rather than a constant: every option gets used across the
  // response set, so severities vary and the domain scores differ from
  // each other instead of all landing on the same number.
  const n = (responseIndex * 7 + questionIndex * 3) % options.length;
  // `n` is a modulo of the length, so the element is always present; the
  // assertion is for noUncheckedIndexedAccess, not a real nullability.
  return options[n]!;
}

async function main(): Promise<void> {
  const admin = await supervisor.user.findFirst({ where: { email: "admin@demo-ngo.org" } });
  if (!admin) throw new Error("Run `pnpm prisma:seed` first (admin@demo-ngo.org not found).");
  const orgId = admin.orgId;

  const mv = await prisma.methodologyVersion.findFirst({ where: { status: "PUBLISHED" } });
  if (!mv) throw new Error("No PUBLISHED MethodologyVersion — run `pnpm import:methodology -- --publish`.");

  // The scoring engine resolves its own version from the survey, so a survey
  // left on a retired version scores nothing however many answers it has.
  const lookups = await prisma.scoringLookup.findMany({
    where: { methodologyVersionId: mv.id, isActive: true, lookupType: "OPTION" },
    select: { questionId: true, optionId: true, severityScore: true, optionOrder: true },
    orderBy: { optionOrder: "asc" },
  });
  if (lookups.length === 0) throw new Error(`No active OPTION lookups for ${mv.version}.`);

  const optionsByQuestion = new Map<string, string[]>();
  for (const l of lookups) {
    if (!l.optionId) continue;
    const list = optionsByQuestion.get(l.questionId) ?? [];
    if (!list.includes(l.optionId)) list.push(l.optionId);
    optionsByQuestion.set(l.questionId, list);
  }

  const questions = await prisma.question.findMany({
    where: { methodologyVersionId: mv.id, measurementMode: "SINGLE_SELECT" },
    select: { id: true, questionId: true, domain: true },
    orderBy: { questionId: "asc" },
  });

  // Only questions the lookups can actually score — an unscoreable question
  // would add an answer row that never becomes a severity score.
  const byDomain = new Map<string, typeof questions>();
  for (const q of questions) {
    const opts = optionsByQuestion.get(q.questionId);
    if (!opts || opts.length < 2) continue;
    const list = byDomain.get(q.domain) ?? [];
    if (list.length < PER_DOMAIN) list.push(q);
    byDomain.set(q.domain, list);
  }
  const chosen = [...byDomain.values()].flat();
  if (chosen.length === 0) throw new Error("No scoreable SINGLE_SELECT questions found.");

  await prisma.$transaction(
    async (tx) => {
      await setOrg(tx, orgId);

      const study = await tx.study.findFirst({ where: { orgId, title: STUDY_TITLE } });
      if (!study) throw new Error(`Study "${STUDY_TITLE}" not found — run \`pnpm seed:scored\` first.`);

      const survey = await tx.survey.findFirst({ where: { studyId: study.id } });
      if (!survey) throw new Error("That study has no survey.");

      // Point study + survey at the published version. Left on a retired one,
      // the engine finds no lookups and silently scores nothing.
      await tx.study.update({ where: { id: study.id }, data: { methodologyVersionId: mv.id } });
      await tx.survey.update({ where: { id: survey.id }, data: { methodologyVersion: mv.version } });

      await tx.surveyQuestion.deleteMany({ where: { surveyId: survey.id } });
      const surveyQuestions: Array<{ id: string; questionId: string }> = [];
      let order = 1;
      for (const q of chosen) {
        const sq = await tx.surveyQuestion.create({
          data: { surveyId: survey.id, questionId: q.id, order: order++, isRequired: true },
          select: { id: true },
        });
        surveyQuestions.push({ id: sq.id, questionId: q.questionId });
      }

      // The engine reads responses by the survey's need, not by survey id.
      const responses = await tx.surveyResponse.findMany({
        where: { needId: survey.needId, exclusionReason: null },
        select: { id: true },
        orderBy: { submittedAt: "asc" },
      });
      if (responses.length === 0) throw new Error("No responses on that need — run `pnpm seed:scored` first.");

      for (const [ri, r] of responses.entries()) {
        // Keyed by SurveyQuestion.id, not the question code: that is what
        // ScoreRollupService reads (`rawAnswers[sq.id]`).
        const answers: Record<string, string> = {};
        for (const [qi, sq] of surveyQuestions.entries()) {
          const opts = optionsByQuestion.get(sq.questionId);
          if (!opts) continue;
          answers[sq.id] = pick(opts, ri, qi);
        }
        await tx.surveyResponse.update({ where: { id: r.id }, data: { answers } });
      }

      console.log(`✅ ${surveyQuestions.length} questions linked across ${byDomain.size} domains`);
      console.log(`   ${responses.length} responses answered · methodology ${mv.version}`);
      console.log(`   study  ${study.id}`);
      console.log(`   survey ${survey.id}`);
      console.log(`   → POST /api/studies/${study.id}/surveys/${survey.id}/recalculate, then generate RPT18.`);
    },
    { timeout: 120_000 },
  );
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
