import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma';
import { orgContext } from '../../tenancy/org-context';
import { PublicSurveysService } from './public-surveys.service';
import { saudiToday } from './survey-link-window';

// UAT DST-04 — every new link needs a start and an end date (Saudi calendar days).
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = saudiToday();
const WINDOW = { startDate: TODAY, endDate: addDays(TODAY, 6) };

vi.mock('qrcode', () => ({ default: { toBuffer: vi.fn().mockResolvedValue(Buffer.from('png')) } }));

const asActor = <T>(fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1' }, fn);

const linkRow = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  needId: 'n1',
  studyId: 's1',
  label: 'Wave 1',
  token: 'tok',
  expiresAt: null as Date | null,
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  _count: { responses: 4 },
  ...over,
});

const survey = (
  id: string,
  version: number,
  status: string,
  questions: Array<Record<string, unknown>>,
) => ({
  id,
  version,
  status,
  surveyQuestions: questions,
});

function setup() {
  const tx = {
    need: { findUnique: vi.fn().mockResolvedValue({ id: 'n1', studyId: 's1', title: 'Water' }) },
    publicSurveyLink: {
      findMany: vi.fn().mockResolvedValue([linkRow()]),
      create: vi.fn().mockResolvedValue(linkRow()),
      findUnique: vi.fn().mockResolvedValue(linkRow()),
      update: vi.fn().mockResolvedValue(linkRow({ isActive: false })),
    },
    surveyResponse: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
    },
    survey: {
      findMany: vi.fn().mockResolvedValue([
        survey('sv1', 1, 'PUBLISHED', [
          {
            id: 'q1',
            surveyId: 'sv1',
            questionId: 'bank-name',
            question: { questionText: 'Name?', answerType: 'short_text', answerOptions: null },
            customText: null,
            customAnswerType: null,
            customOptions: null,
          },
          {
            id: 'q2',
            surveyId: 'sv1',
            questionId: 'bank-pick',
            question: { questionText: 'Pick', answerType: 'select', answerOptions: '["a","b"]' },
            customText: null,
            customAnswerType: null,
            customOptions: null,
          },
          {
            id: 'q3',
            surveyId: 'sv1',
            questionId: null,
            question: null,
            customText: 'Custom?',
            customAnswerType: 'numeric',
            customOptions: ['x'],
          },
        ]),
        survey('sv2', 2, 'DRAFT', [
          {
            id: 'q4',
            surveyId: 'sv2',
            questionId: 'bank-name',
            question: { questionText: 'Name?', answerType: 'short_text', answerOptions: null },
            customText: null,
            customAnswerType: null,
            customOptions: null,
          },
          {
            id: 'q5',
            surveyId: 'sv2',
            questionId: null,
            question: null,
            customText: null,
            customAnswerType: null,
            customOptions: null,
          },
        ]),
      ]),
    },
  };
  const tenant = {
    runRead: async (fn: (t: unknown) => unknown) => fn(tx),
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const mailer = { sendSurveyLink: vi.fn().mockResolvedValue(true) };
  const config = { publicAppUrl: 'https://app.test' };
  const translation = {
    translate: vi.fn().mockResolvedValue({ translatedText: 'الماء', unchanged: false }),
  };
  return {
    tx,
    audit,
    mailer,
    translation,
    svc: new PublicSurveysService(
      tenant as never,
      config as never,
      audit as never,
      mailer as never,
      translation as never,
    ),
  };
}

describe('PublicSurveysService links', () => {
  it('lists the links of a need with their public URL and response count', async () => {
    const { svc } = setup();
    expect(await svc.listLinks('n1')).toEqual([
      expect.objectContaining({
        // UAT-02: every generated public-survey link forces `/ar/` — see
        // toPublicLink's own comment.
        publicUrl: 'https://app.test/ar/public/survey/tok',
        responseCount: 4,
        expiresAt: null,
      }),
    ]);
  });

  it('404s an unknown need', async () => {
    const { svc, tx } = setup();
    tx.need.findUnique.mockResolvedValue(null);
    await expect(svc.listLinks('x')).rejects.toMatchObject({
      response: { error: { code: 'NEED_NOT_FOUND' } },
    });
  });

  it('creates a link open from 00:00 Saudi time on the start date to the end of the end date, and audits both dates', async () => {
    const { svc, tx, audit } = setup();
    tx.publicSurveyLink.create.mockResolvedValue(
      linkRow({ startsAt: new Date('2026-02-01T00:00:00+03:00'), expiresAt: new Date('2026-02-07T23:59:59.999+03:00') }),
    );
    const link = await asActor(() => svc.createLink('n1', { label: '  Wave 1 ', ...WINDOW }));
    expect(link.startsAt).toBe('2026-01-31T21:00:00.000Z');
    expect(link.expiresAt).toBe('2026-02-07T20:59:59.999Z');
    const data = tx.publicSurveyLink.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ label: 'Wave 1', orgId: 'org-1', createdBy: 'u1', needId: 'n1' });
    expect((data.startsAt as Date).toISOString()).toBe(new Date(`${WINDOW.startDate}T00:00:00+03:00`).toISOString());
    expect((data.expiresAt as Date).toISOString()).toBe(new Date(`${WINDOW.endDate}T23:59:59.999+03:00`).toISOString());
    const changes = (audit.record.mock.calls[0]![0] as { changes: { field: string; after: unknown }[] }).changes;
    expect(changes).toEqual(expect.arrayContaining([
      { field: 'Start date', before: null, after: WINDOW.startDate },
      { field: 'End date', before: null, after: WINDOW.endDate },
    ]));
  });

  it('UAT DST-04 — refuses a past start date, an end before the start, and a window over 365 days, creating nothing', async () => {
    const { svc, tx } = setup();
    for (const [startDate, endDate, code] of [
      [addDays(TODAY, -1), TODAY, 'SURVEY_LINK_START_IN_PAST'],
      [addDays(TODAY, 5), addDays(TODAY, 4), 'SURVEY_LINK_END_BEFORE_START'],
      [TODAY, addDays(TODAY, 365), 'SURVEY_LINK_WINDOW_TOO_LONG'],
    ]) {
      await expect(asActor(() => svc.createLink('n1', { label: 'L', startDate: startDate!, endDate: endDate! }))).rejects.toMatchObject({
        response: { error: { code } },
      });
    }
    expect(tx.publicSurveyLink.create).not.toHaveBeenCalled();
  });

  it('maps a duplicate label to a conflict and rethrows other failures', async () => {
    const { svc, tx } = setup();
    tx.publicSurveyLink.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(
      asActor(() => svc.createLink('n1', { label: 'L', ...WINDOW })),
    ).rejects.toBeInstanceOf(ConflictException);
    tx.publicSurveyLink.create.mockRejectedValueOnce(new Error('db'));
    await expect(asActor(() => svc.createLink('n1', { label: 'L', ...WINDOW }))).rejects.toThrow(
      'db',
    );
  });

  it('deactivates a link of the need and audits it, and 404s a link of another need', async () => {
    const { svc, tx, audit } = setup();
    expect((await svc.deactivateLink('n1', 'l1')).isActive).toBe(false);
    expect(audit.record).toHaveBeenCalled();
    tx.publicSurveyLink.findUnique.mockResolvedValueOnce(linkRow({ needId: 'other' }));
    await expect(svc.deactivateLink('n1', 'l1')).rejects.toBeInstanceOf(NotFoundException);
    tx.publicSurveyLink.findUnique.mockResolvedValueOnce(null);
    await expect(svc.deactivateLink('n1', 'l1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('emails the link with a QR code, audits it, and fails clearly when sending fails', async () => {
    const { svc, tx, mailer, audit } = setup();
    await svc.shareLinkByEmail('n1', 'l1', 'a@b.test');
    expect(mailer.sendSurveyLink).toHaveBeenCalledWith(
      'a@b.test',
      expect.objectContaining({
        publicUrl: 'https://app.test/ar/public/survey/tok',
        needTitle: 'Water',
        needTitleAr: 'الماء',
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'share' }));
    mailer.sendSurveyLink.mockResolvedValueOnce(false);
    await expect(svc.shareLinkByEmail('n1', 'l1', 'a@b.test')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    tx.publicSurveyLink.findUnique.mockResolvedValueOnce(null);
    await expect(svc.shareLinkByEmail('n1', 'l1', 'a@b.test')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('PublicSurveysService responses', () => {
  const response = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    needId: 'n1',
    surveyLinkId: 'l1',
    contactName: 'Ana',
    contact: 'ana@x.test',
    submittedAt: new Date('2026-03-01T00:00:00Z'),
    answers: { q1: 'Ana', q2: 'a', q4: '   ' },
    ...over,
  });

  it('pages responses with a search and link filter, clamping limits', async () => {
    const { svc, tx } = setup();
    tx.surveyResponse.findMany.mockResolvedValue([response()]);
    tx.surveyResponse.count.mockResolvedValue(25);
    const result = await svc.listResponses('n1', {
      surveyLinkId: 'l1',
      search: ' ana ',
      limit: 9999,
      offset: -1,
    });
    expect(result).toMatchObject({ total: 25, limit: 200, offset: 0 });
    expect(tx.surveyResponse.findMany.mock.calls[0]![0].where).toMatchObject({
      surveyLinkId: 'l1',
    });
    expect(tx.surveyResponse.findMany.mock.calls[0]![0].where.OR).toHaveLength(2);
    await svc.listResponses('n1');
    expect(tx.surveyResponse.findMany.mock.calls[1]![0].take).toBe(10);
  });

  it('lists responses with their answers joined to the questions across survey versions', async () => {
    const { svc, tx } = setup();
    tx.surveyResponse.findMany.mockResolvedValue([response()]);
    const [detail] = await svc.listResponsesWithAnswers('n1', 'l1');
    expect(detail!.answers.map((a) => a.questionId).sort()).toEqual(['q1', 'q2', 'q4']);
    expect(detail!.answers.find((a) => a.questionId === 'q2')!.answerOptions).toEqual(['a', 'b']);
  });

  it("shows one question's answers across every version that copied it", async () => {
    const { svc, tx } = setup();
    tx.surveyResponse.findMany.mockResolvedValue([
      response(),
      response({ id: 'r2', answers: { q4: 'From v2' } }),
      response({ id: 'r3', answers: null }),
    ]);
    tx.surveyResponse.count.mockResolvedValue(3);
    const result = await svc.listQuestionResponses('n1', 'q1', {
      search: 'a',
      limit: 5,
      offset: 0,
    });
    expect(result).toMatchObject({
      questionId: 'q1',
      questionText: 'Name?',
      answerType: 'short_text',
      total: 3,
    });
    expect(result.items.map((i) => i.answer)).toEqual(['Ana', 'From v2', null]);
    const unknown = await svc.listQuestionResponses('n1', 'nope');
    expect(unknown).toMatchObject({ questionText: '', answerType: 'long_text' });
  });

  it('returns one response, and 404s an unknown one or one of another need', async () => {
    const { svc, tx } = setup();
    tx.surveyResponse.findUnique.mockResolvedValueOnce(response());
    expect((await svc.getResponse('n1', 'r1')).id).toBe('r1');
    tx.surveyResponse.findUnique.mockResolvedValueOnce(response({ needId: 'other' }));
    await expect(svc.getResponse('n1', 'r1')).rejects.toMatchObject({
      response: { error: { code: 'SURVEY_RESPONSE_NOT_FOUND' } },
    });
    tx.surveyResponse.findUnique.mockResolvedValueOnce(null);
    await expect(svc.getResponse('n1', 'r1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('labels each exported response with the survey version it answered', async () => {
    const { svc, tx } = setup();
    tx.surveyResponse.findMany.mockResolvedValueOnce([
      response(),
      response({ id: 'r2', answers: { zzz: 'x' } }),
      response({ id: 'r3', answers: { q4: 'v2' } }),
    ]);
    const csv = await svc.exportResponsesCsv('n1', 'l1');
    expect(csv).toContain('"v1 (PUBLISHED)"');
    expect(csv).toContain('"Unknown"');
    expect(csv).toContain('"v2 (DRAFT)"');
  });
});
