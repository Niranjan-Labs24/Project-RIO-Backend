import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { PrismaClient } from '../src/generated/prisma';

// GAP-04 shared fixture. Builds a fully self-contained, scoreable citizen
// SurveyResponse (methodology version + one SINGLE_SELECT scoreable question +
// its OPTION scoring lookup + study/need/published survey/survey-question +
// public link + response) under a fresh throwaway org, so the durable-scoring
// integration tests don't depend on the imported methodology/question bank
// (which is not present in a plain `prisma:seed` DB).
//
// All writes go through the owner connection inside a per-org transaction that
// sets app.current_org_id — tenant tables are FORCE ROW LEVEL SECURITY even
// for the owner (mirrors prisma/seed.ts / seed-scored-study.ts).

export interface Gap04Fixture {
  orgId: string;
  studyId: string;
  needId: string;
  surveyId: string;
  responseId: string;
  methodologyVersionId: string;
  villageId: string;
  // The question code (e.g. 'GAP04-Q1') this fixture scores.
  questionId: string;
  // Cleanup: removes every row this fixture created (org-scoped where RLS applies).
  cleanup: () => Promise<void>;
}

const VILLAGE = 'GAP04-Village';

async function setOrg(tx: { $executeRawUnsafe: (s: string, ...a: unknown[]) => Promise<number> }, orgId: string): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, orgId);
}

export async function createGap04Fixture(owner: PrismaClient): Promise<Gap04Fixture> {
  const orgId = uuidv7();
  const createdBy = uuidv7();
  const questionId = `GAP04-Q1-${Date.now()}`;
  const optionId = 'HIGH';
  const versionLabel = `gap04-mv-${randomBytes(6).toString('hex')}`;

  // MethodologyVersion is GLOBAL reference data (no RLS) — create it outside
  // the org-scoped transaction. PUBLISHED so scoreResponse's fallback lookup
  // (status: 'PUBLISHED') resolves it.
  const mv = await owner.methodologyVersion.create({
    data: { name: 'GAP04 Test MV', version: versionLabel, status: 'PUBLISHED', createdBy },
  });

  // Question bank row (also global — no org scoping / RLS).
  await owner.question.create({
    data: {
      questionId,
      domain: 'Health',
      subDomain: 'Access',
      indicator: 'GAP04 Indicator',
      kpi: 'GAP04 KPI',
      questionText: 'GAP04 scoreable question',
      answerType: 'select',
      requiredOptional: 'required',
      usedInMvp: true,
      measurementMode: 'SINGLE_SELECT',
      isScoreable: true,
      methodologyVersionId: mv.id,
    },
  });

  // Scoring lookup for the one option we answer — a plain (non-excluded) 80.
  await owner.scoringLookup.create({
    data: {
      methodologyVersionId: mv.id,
      questionId,
      lookupType: 'OPTION',
      optionId,
      severityScore: 80,
      isActive: true,
    },
  });

  // Org-scoped tenant rows.
  const ids = await owner.$transaction(async (tx) => {
    await setOrg(tx, orgId);
    await tx.$executeRawUnsafe(
      `INSERT INTO organisations (id, name, updated_at) VALUES ($1::uuid, $2, now())`,
      orgId,
      'GAP04 Org',
    );
    const study = await tx.study.create({
      data: { orgId, title: 'GAP04 Study', villages: [VILLAGE], cycleNumber: 1, methodologyVersionId: mv.id, createdBy },
    });
    const need = await tx.need.create({
      data: {
        orgId,
        studyId: study.id,
        title: 'GAP04 Need',
        statement: 'GAP04 durable scoring fixture need.',
        source: 'field_survey',
        village: [VILLAGE],
        domain: 'Health',
        subDomain: 'Access',
        createdBy,
      },
    });
    const survey = await tx.survey.create({
      data: {
        orgId,
        needId: need.id,
        studyId: study.id,
        title: 'GAP04 Survey',
        status: 'PUBLISHED',
        methodologyVersion: mv.version,
        publishedAt: new Date(),
        createdBy,
      },
    });
    // Map the Question Bank question onto this survey. The SurveyQuestion.id is
    // the key used inside SurveyResponse.answers (see CitizenService.resolveSurvey).
    const questionRow = await tx.question.findFirstOrThrow({ where: { methodologyVersionId: mv.id, questionId } });
    const sq = await tx.surveyQuestion.create({
      data: { surveyId: survey.id, questionId: questionRow.id, order: 1, isRequired: true },
    });
    const link = await tx.publicSurveyLink.create({
      data: { orgId, needId: need.id, studyId: study.id, label: 'GAP04 Link', token: randomBytes(16).toString('hex'), createdBy },
    });
    const contact = `gap04-${Date.now()}@seed.local`;
    const response = await tx.surveyResponse.create({
      data: {
        orgId,
        needId: need.id,
        studyId: study.id,
        surveyLinkId: link.id,
        contact,
        // Blind index is required (NOT NULL); any fixed hex works for the fixture.
        contactBlindIndex: randomBytes(32).toString('hex'),
        village: [VILLAGE],
        // Keyed by the SurveyQuestion.id, valued by the option display label.
        answers: { [sq.id]: 'High' },
      },
    });
    return { studyId: study.id, needId: need.id, surveyId: survey.id, responseId: response.id };
  });

  const cleanup = async (): Promise<void> => {
    // Delete org-scoped rows inside the org context (RLS-forced tables).
    await owner.$transaction(async (tx) => {
      await setOrg(tx, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM response_severity_scores WHERE org_id = $1::uuid`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM response_answers WHERE org_id = $1::uuid`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM score_rollups WHERE org_id = $1::uuid`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM survey_responses WHERE org_id = $1::uuid`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM survey_questions WHERE survey_id IN (SELECT id FROM surveys WHERE org_id = $1::uuid)`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM public_survey_links WHERE org_id = $1::uuid`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM surveys WHERE org_id = $1::uuid`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM need_domains WHERE org_id = $1::uuid`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM needs WHERE org_id = $1::uuid`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM studies WHERE org_id = $1::uuid`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM organisations WHERE id = $1::uuid`, orgId);
    });
    // Global (no-RLS) rows last, after the tenant rows that reference them.
    await owner.scoringLookup.deleteMany({ where: { methodologyVersionId: mv.id } });
    await owner.question.deleteMany({ where: { methodologyVersionId: mv.id } });
    await owner.methodologyVersion.delete({ where: { id: mv.id } });
  };

  return {
    orgId,
    studyId: ids.studyId,
    needId: ids.needId,
    surveyId: ids.surveyId,
    responseId: ids.responseId,
    methodologyVersionId: mv.id,
    villageId: VILLAGE,
    questionId,
    cleanup,
  };
}
