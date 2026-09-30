import { describe, expect, it, vi } from 'vitest';
import { PublicSurveysService } from './public-surveys.service';

/**
 * Regression cover for answer-to-question mapping.
 *
 * The fixture is the shape of real data, not an invented edge case: the
 * Question Bank holds two distinct Education questions worded identically
 * ("What is the approximate distance from this household to the nearest
 * primary school?", under sub-domains "Access to Basic Education" and
 * "Basic Education Access"), and a local survey asks both. Mapping used to
 * treat question TEXT as a question's identity, so the second one was folded
 * into the first: real answers vanished from the summary page, the export
 * lost a column, and the second question's own responses page served the
 * first question's answers.
 *
 * Identity is now the Question Bank id, which createNewVersion carries from
 * one survey version to the next — so merging across versions still works,
 * while two different questions stay two questions.
 */

const BANK_DISTANCE_A = 'bank-distance-access-to-basic-education';
const BANK_DISTANCE_B = 'bank-distance-basic-education-access';
const BANK_SAFE_ROUTE = 'bank-safe-route';

const SAME_TEXT =
  'What is the approximate distance from this household to the nearest primary school?';

function bankQuestion(
  id: string,
  surveyId: string,
  bankQuestionId: string,
  questionText: string,
) {
  return {
    id,
    surveyId,
    questionId: bankQuestionId,
    customText: null,
    customAnswerType: null,
    customOptions: null,
    question: { questionText, answerType: 'short_text', answerOptions: null },
  };
}

function customQuestion(id: string, surveyId: string, customText: string) {
  return {
    id,
    surveyId,
    questionId: null,
    customText,
    customAnswerType: 'long_text',
    customOptions: null,
    question: null,
  };
}

// v1 is PUBLISHED and was answered; v2 is the copy createNewVersion made,
// with fresh SurveyQuestion ids but the same bank ids.
const SURVEY_V1 = {
  id: 's1',
  version: 1,
  surveyQuestions: [
    bankQuestion('v1-qa', 's1', BANK_DISTANCE_A, SAME_TEXT),
    bankQuestion('v1-qb', 's1', BANK_DISTANCE_B, SAME_TEXT),
    bankQuestion('v1-qc', 's1', BANK_SAFE_ROUTE, 'Is the route to school safe?'),
  ],
};
const SURVEY_V2 = {
  id: 's2',
  version: 2,
  surveyQuestions: [
    bankQuestion('v2-qa', 's2', BANK_DISTANCE_A, SAME_TEXT),
    bankQuestion('v2-qb', 's2', BANK_DISTANCE_B, SAME_TEXT),
    bankQuestion('v2-qc', 's2', BANK_SAFE_ROUTE, 'Is the route to school safe?'),
  ],
};

const NEED = { id: 'need-1' };

function makeService(surveys: unknown[], responses: unknown[]) {
  const tx = {
    need: { findUnique: vi.fn().mockResolvedValue(NEED) },
    survey: { findMany: vi.fn().mockResolvedValue(surveys) },
    surveyResponse: {
      findMany: vi.fn().mockResolvedValue(responses),
      count: vi.fn().mockResolvedValue(responses.length),
    },
  };
  const tenant = {
    runRead: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)),
    runInOrgContext: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)),
  };
  const service = new PublicSurveysService(
    tenant as never,
    { publicAppUrl: 'http://localhost:3001' } as never,
    { record: vi.fn() } as never,
    { send: vi.fn() } as never,
    { translate: vi.fn().mockResolvedValue({ translatedText: '', unchanged: true }) } as never,
  );
  return { service, tx };
}

function response(id: string, answers: Record<string, string>) {
  return {
    id,
    needId: 'need-1',
    surveyLinkId: 'link-1',
    contactName: `Respondent ${id}`,
    contact: `${id}@example.org`,
    submittedAt: new Date('2026-01-01T00:00:00.000Z'),
    answers,
  };
}

// One response per version, each answering all three questions.
const ANSWERED_V1 = response('r1', { 'v1-qa': '2 km', 'v1-qb': '5 km', 'v1-qc': 'Yes' });
const ANSWERED_V2 = response('r2', { 'v2-qa': '1 km', 'v2-qb': '9 km', 'v2-qc': 'No' });

describe('answers map to the question that was actually asked', () => {
  it('keeps two identically worded questions apart in a response detail', async () => {
    const { service } = makeService([SURVEY_V1, SURVEY_V2], [ANSWERED_V1]);

    const [detail] = await service.listResponsesWithAnswers('need-1');

    expect(detail!.answers).toHaveLength(3);
    expect(detail!.answers.map((a) => a.answer)).toEqual(['2 km', '5 km', 'Yes']);
    // The bank id travels with the answer so the frontend can merge across
    // versions without falling back to the wording.
    expect(detail!.answers.map((a) => a.bankQuestionId)).toEqual([
      BANK_DISTANCE_A,
      BANK_DISTANCE_B,
      BANK_SAFE_ROUTE,
    ]);
  });

  it('gives each identically worded question its own export column', async () => {
    const { service } = makeService([SURVEY_V1, SURVEY_V2], [ANSWERED_V1]);

    const csv = await service.exportResponsesCsv('need-1');
    const [header, row] = csv.split('\n');

    // Name, Email, Submitted Date, Survey Version + one per question.
    expect(header!.split(',')).toHaveLength(4 + 3);
    expect(row).toContain('"2 km"');
    expect(row).toContain('"5 km"'); // used to be swallowed by the first column
    expect(row).toContain('"Yes"');
  });

  it('serves the second question own answers on its own responses page', async () => {
    const { service } = makeService([SURVEY_V1, SURVEY_V2], [ANSWERED_V1]);

    const first = await service.listQuestionResponses('need-1', 'v1-qa');
    const second = await service.listQuestionResponses('need-1', 'v1-qb');

    expect(first.items[0]!.answer).toBe('2 km');
    expect(second.items[0]!.answer).toBe('5 km');
  });

  it('still merges the same question across survey versions', async () => {
    const { service } = makeService([SURVEY_V1, SURVEY_V2], [ANSWERED_V1, ANSWERED_V2]);

    // Asked for v2's id; r1 answered under v1's copy and must still count.
    const merged = await service.listQuestionResponses('need-1', 'v2-qb');

    expect(merged.items.map((i) => i.answer)).toEqual(['5 km', '9 km']);
  });

  it('keeps two identically worded custom questions apart, and pairs them across versions', async () => {
    // A custom question has no bank row, so wording is the only identity it
    // has — but two of them in ONE version are still two questions.
    const v1 = {
      id: 's1',
      version: 1,
      surveyQuestions: [
        customQuestion('v1-c1', 's1', 'Anything else?'),
        customQuestion('v1-c2', 's1', 'Anything else?'),
      ],
    };
    const v2 = {
      id: 's2',
      version: 2,
      surveyQuestions: [
        customQuestion('v2-c1', 's2', 'Anything else?'),
        customQuestion('v2-c2', 's2', 'Anything else?'),
      ],
    };
    const { service } = makeService(
      [v1, v2],
      [response('r1', { 'v1-c1': 'first', 'v1-c2': 'second' })],
    );

    const csv = await service.exportResponsesCsv('need-1');
    const [header, row] = csv.split('\n');

    expect(header!.split(',')).toHaveLength(4 + 2);
    expect(row).toContain('"first"');
    expect(row).toContain('"second"');

    // The nth copy in v1 pairs with the nth copy in v2, never with the other.
    const second = await service.listQuestionResponses('need-1', 'v2-c2');
    expect(second.items[0]!.answer).toBe('second');
  });
});
