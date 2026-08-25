import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../src/generated/prisma";
import { pgSslFromEnv } from "../src/prisma/pg-ssl";

// Seeds the two things RPT10 (Data-Quality) reports on that no other seed
// produces — run AFTER `pnpm seed:scored`, which creates the study this
// augments. Run: pnpm seed:data-quality
//
//   1. A real question set on the seeded survey, with required and optional
//      questions, and answers on the 38 seeded responses that deliberately
//      leave some REQUIRED ones blank. Without this the seeded responses have
//      `answers: {}` and the unanswered-required section correctly reports
//      "nothing was asked, so nothing can be unanswered" — accurate, and
//      useless for seeing the feature work.
//
//   2. Survey sessions: submitted, abandoned at several different stages, and
//      two still in flight. This is the client's 24 Aug answer made visible —
//      abandonment tracked at session/event level, counted as invalid
//      responses, with no partial answer data anywhere in the session rows.
//
// Idempotent: re-running detects the question set / sessions and skips.
//
// SEED DATA ONLY. The abandonment rows here are fabricated for local testing;
// the sessions a real deployment reports on are written by the citizen flow
// itself (SurveySessionsService), never by this script.

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
const MINUTE = 60_000;

/** Answer values are arbitrary — nothing scores off them. What matters for
 *  RPT10 is which are PRESENT and which are blank on a required question. */
const ANSWER_POOL = ["Yes", "No", "Sometimes", "Don't know"];

async function main(): Promise<void> {
  const admin = await supervisor.user.findFirst({ where: { email: "admin@demo-ngo.org" } });
  if (!admin) throw new Error("Run `pnpm prisma:seed` first (admin@demo-ngo.org not found).");
  const orgId = admin.orgId;

  await prisma.$transaction(
    async (tx) => {
      await setOrg(tx, orgId);

      const study = await tx.study.findFirst({ where: { orgId, title: STUDY_TITLE } });
      if (!study) throw new Error(`Study "${STUDY_TITLE}" not found — run \`pnpm seed:scored\` first.`);

      const survey = await tx.survey.findFirst({
        where: { studyId: study.id, status: "PUBLISHED" },
        include: { surveyQuestions: { select: { id: true } } },
      });
      if (!survey) throw new Error(`No published survey on study ${study.id}.`);

      // ── 1. Question set ──────────────────────────────────────────────────
      let questionIds: Array<{ id: string; required: boolean }>;
      if (survey.surveyQuestions.length > 0) {
        console.log(`Survey already has ${survey.surveyQuestions.length} question(s) — leaving them as they are.`);
        const rows = await tx.surveyQuestion.findMany({
          where: { surveyId: survey.id },
          select: { id: true, isRequired: true },
          orderBy: { order: "asc" },
        });
        questionIds = rows.map((r) => ({ id: r.id, required: r.isRequired }));
      } else {
        // Real Question Bank rows, so each question carries its own domain /
        // sub-domain / KPI and the per-domain columns in RPT10 are populated
        // from real methodology data rather than invented strings.
        const bank = await tx.question.findMany({
          where: { domain: { in: ["Health", "Water & Sanitation", "Education"] } },
          orderBy: { domain: "asc" },
          take: 8,
        });
        if (bank.length < 4) throw new Error("Question bank is empty — run the question import first.");

        // The last two are optional: an unanswered OPTIONAL question is not a
        // gap, and the report must not count it as one. Seeding both kinds is
        // what makes that visible.
        questionIds = [];
        for (const [i, q] of bank.entries()) {
          const required = i < bank.length - 2;
          const created = await tx.surveyQuestion.create({
            data: { surveyId: survey.id, questionId: q.id, order: i + 1, isRequired: required },
            select: { id: true },
          });
          questionIds.push({ id: created.id, required });
        }
        console.log(`Added ${questionIds.length} questions (${questionIds.filter((q) => q.required).length} required).`);
      }

      // ── 2. Answers, with deliberate gaps on required questions ───────────
      const responses = await tx.surveyResponse.findMany({
        where: { studyId: study.id },
        select: { id: true, answers: true },
        orderBy: { submittedAt: "asc" },
      });

      const alreadyAnswered = responses.filter(
        (r) => Object.keys((r.answers as Record<string, unknown>) ?? {}).length > 0,
      ).length;
      if (alreadyAnswered > 0) {
        console.log(`${alreadyAnswered} response(s) already carry answers — leaving them as they are.`);
      } else {
        const firstRequired = questionIds.find((q) => q.required)?.id;
        const secondRequired = questionIds.filter((q) => q.required)[1]?.id;
        for (const [i, response] of responses.entries()) {
          const answers: Record<string, string> = {};
          for (const q of questionIds) {
            // Every 5th response leaves the first required question blank, and
            // every 7th leaves the second — two questions with different gap
            // rates, so the "Required Questions With Gaps" table has something
            // to rank. A blank is stored as "", exactly what the citizen page
            // sends for a skipped question.
            if (q.id === firstRequired && i % 5 === 0) {
              answers[q.id] = "";
              continue;
            }
            if (q.id === secondRequired && i % 7 === 0) {
              answers[q.id] = "   "; // whitespace-only — also a gap, and the loader must treat it as one
              continue;
            }
            // Optional questions are genuinely left out by some respondents:
            // absent from the payload entirely, not blank.
            if (!q.required && i % 3 === 0) continue;
            answers[q.id] = ANSWER_POOL[i % ANSWER_POOL.length]!;
          }
          await tx.surveyResponse.update({ where: { id: response.id }, data: { answers } });
        }
        const gaps =
          responses.filter((_, i) => i % 5 === 0).length + responses.filter((_, i) => i % 7 === 0).length;
        console.log(`Filled answers on ${responses.length} responses, with ${gaps} required-question gap(s).`);
      }

      // ── 3. Study-wide rollups ────────────────────────────────────────────
      //
      // `pnpm seed:scored` writes rollups scoped to village "Ad-Dilam" only.
      // The real scoring path writes BOTH a village row and a study-wide one
      // (see ScoreRollupService.calculateRollups, which CitizenService calls
      // twice — once with a villageId and once with null), and every
      // study-scoped report resolves the study-wide row: `rollupVillageId =
      // villageId || ''` in ReportSummaryService. Without the mirror,
      // RPT03/RPT10 generated from the UI — which offers no village picker —
      // find nothing and return STUDY_NOT_SCORED.
      const villageRollups = await tx.scoreRollup.findMany({
        where: { studyId: study.id, villageId: { not: "" } },
      });
      const studyWide = await tx.scoreRollup.count({ where: { studyId: study.id, villageId: "" } });
      if (studyWide > 0) {
        console.log(`${studyWide} study-wide rollup(s) already present — leaving them as they are.`);
      } else {
        for (const r of villageRollups) {
          const { id, createdAt, updatedAt, villageId: _v, ...rest } = r as typeof r & {
            createdAt?: Date;
            updatedAt?: Date;
          };
          void id;
          void createdAt;
          void updatedAt;
          await tx.scoreRollup.create({ data: { ...rest, villageId: "" } });
        }
        const vpa = await tx.villagePriorityAssessment.findFirst({
          where: { studyId: study.id, villageId: { not: "" } },
        });
        if (vpa) {
          const { id, createdAt, updatedAt, villageId: _v2, ...rest } = vpa as typeof vpa & {
            createdAt?: Date;
            updatedAt?: Date;
          };
          void id;
          void createdAt;
          void updatedAt;
          await tx.villagePriorityAssessment.create({
            data: {
              ...rest,
              villageId: "",
              // `domainComponents` is non-null in the schema, but a JSON column
              // reads back as JsonValue (null included), which the create input
              // rejects.
              domainComponents: rest.domainComponents as Prisma.InputJsonValue,
            },
          });
        }
        console.log(`Mirrored ${villageRollups.length} rollup(s) + priority assessment to study-wide scope.`);
      }

      // The invalid-response block is only worth looking at when BOTH of its
      // components are non-zero — the client's rule is that abandoned sittings
      // are added to the excluded-submitted count, and a "0 + 10" reads as
      // though only one source exists. `pnpm seed:scored` sets the OVERALL
      // rollup's valid count equal to the number of response rows, which makes
      // excluded = submitted - valid = 0. Hold four responses back as excluded
      // by scoring, the way a real quality screen would.
      const responseCount = responses.length;
      const EXCLUDED = 4;
      await tx.scoreRollup.updateMany({
        where: { studyId: study.id, villageId: "", rollupLevel: "OVERALL" },
        data: { validResponseCount: responseCount - EXCLUDED, excludedResponseCount: EXCLUDED },
      });

      // ── 4. Survey sessions ───────────────────────────────────────────────
      const existingSessions = await tx.surveySession.count({ where: { studyId: study.id } });
      if (existingSessions > 0) {
        console.log(`${existingSessions} survey session(s) already seeded — nothing to do.`);
        return;
      }

      const link = await tx.publicSurveyLink.findFirst({ where: { studyId: study.id } });
      if (!link) throw new Error(`No public survey link on study ${study.id}.`);

      const questionCount = questionIds.length;
      const now = Date.now();
      const ago = (minutes: number) => new Date(now - minutes * MINUTE);

      // One SUBMITTED session per seeded response, so "sessions submitted"
      // reconciles with "responses received" — the @unique on
      // surveySession.surveyResponseId is what makes that impossible to
      // double-count.
      for (const [i, response] of responses.entries()) {
        const started = ago(600 - i * 5);
        await tx.surveySession.create({
          data: {
            orgId,
            needId: link.needId,
            studyId: study.id,
            surveyLinkId: link.id,
            surveyId: survey.id,
            status: "SUBMITTED",
            furthestStep: "SUBMITTED",
            questionCount,
            answeredCount: questionCount,
            contact: `respondent-${i + 1}@seed.local`,
            surveyResponseId: response.id,
            startedAt: started,
            lastEventAt: new Date(started.getTime() + 6 * MINUTE),
            submittedAt: new Date(started.getTime() + 6 * MINUTE),
            events: {
              create: [
                { orgId, step: "OPENED", position: 0, occurredAt: started },
                { orgId, step: "DETAILS", position: 0, occurredAt: new Date(started.getTime() + MINUTE) },
                { orgId, step: "OTP_VERIFIED", position: 0, occurredAt: new Date(started.getTime() + 2 * MINUTE) },
                { orgId, step: "SUBMITTED", position: questionCount, occurredAt: new Date(started.getTime() + 6 * MINUTE) },
              ],
            },
          },
        });
      }

      // Abandoned: spread across stages so "Where Respondents Stopped" shows a
      // real distribution. All are idle well past the 120-minute default
      // threshold, so they classify as abandoned however long after seeding
      // the report is generated.
      const abandoned: Array<{
        step: "OPENED" | "DETAILS" | "OTP_REQUESTED" | "OTP_VERIFIED" | "ANSWERING" | "REVIEW";
        answered: number;
        idleMinutes: number;
        contactable: boolean;
        reminders: number;
      }> = [
        { step: "OPENED", answered: 0, idleMinutes: 900, contactable: false, reminders: 0 },
        { step: "OPENED", answered: 0, idleMinutes: 840, contactable: false, reminders: 0 },
        { step: "OPENED", answered: 0, idleMinutes: 780, contactable: false, reminders: 0 },
        { step: "DETAILS", answered: 0, idleMinutes: 720, contactable: true, reminders: 1 },
        { step: "DETAILS", answered: 0, idleMinutes: 690, contactable: true, reminders: 2 },
        { step: "OTP_REQUESTED", answered: 0, idleMinutes: 660, contactable: true, reminders: 1 },
        { step: "OTP_VERIFIED", answered: 0, idleMinutes: 600, contactable: true, reminders: 0 },
        { step: "ANSWERING", answered: Math.max(1, Math.round(questionCount * 0.3)), idleMinutes: 540, contactable: true, reminders: 2 },
        { step: "ANSWERING", answered: Math.max(1, Math.round(questionCount * 0.6)), idleMinutes: 480, contactable: true, reminders: 1 },
        { step: "REVIEW", answered: questionCount, idleMinutes: 420, contactable: true, reminders: 1 },
      ];

      for (const [i, a] of abandoned.entries()) {
        const started = ago(a.idleMinutes + 15);
        const last = ago(a.idleMinutes);
        await tx.surveySession.create({
          data: {
            orgId,
            needId: link.needId,
            studyId: study.id,
            surveyLinkId: link.id,
            surveyId: survey.id,
            // The sweep would have written this; seeding it directly matches
            // what a live system looks like a few hours in. RPT10 re-derives
            // the same classification from lastEventAt regardless.
            status: "ABANDONED",
            furthestStep: a.step,
            questionCount,
            answeredCount: a.answered,
            contact: a.contactable ? `dropout-${i + 1}@seed.local` : null,
            mobile: a.contactable ? `+96650000${String(i + 10).padStart(4, "0")}` : null,
            startedAt: started,
            lastEventAt: last,
            abandonedAt: new Date(last.getTime() + 120 * MINUTE),
            remindersSent: a.reminders,
            lastReminderAt: a.reminders > 0 ? new Date(last.getTime() + 30 * MINUTE) : null,
            events: { create: [{ orgId, step: "OPENED", position: 0, occurredAt: started }] },
          },
        });
      }

      // In flight: inside the idle window, so counted on NEITHER side of the
      // rate. Seeded precisely so that behaviour is visible rather than
      // theoretical — the tiles show them separately from abandoned.
      for (const i of [0, 1]) {
        const started = ago(20 - i * 5);
        await tx.surveySession.create({
          data: {
            orgId,
            needId: link.needId,
            studyId: study.id,
            surveyLinkId: link.id,
            surveyId: survey.id,
            status: "VERIFIED",
            furthestStep: "ANSWERING",
            questionCount,
            answeredCount: 1 + i,
            contact: `inflight-${i + 1}@seed.local`,
            startedAt: started,
            lastEventAt: ago(3 - i),
            events: { create: [{ orgId, step: "OPENED", position: 0, occurredAt: started }] },
          },
        });
      }

      console.log(
        `✅ Seeded ${responses.length} submitted, ${abandoned.length} abandoned and 2 in-flight session(s) ` +
          `on study "${STUDY_TITLE}".`,
      );
      console.log(
        `   Expected in RPT10: abandonment rate ${(
          (abandoned.length / (abandoned.length + responses.length)) *
          100
        ).toFixed(1)}% of ${abandoned.length + responses.length} resolved sessions, ` +
          `${abandoned.length} abandoned session(s) added to the invalid-response count.`,
      );
    },
    { timeout: 120_000 },
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
