import { describe, expect, it, vi } from 'vitest';
import { CitizenService } from './citizen.service';

const link = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  orgId: 'org-1',
  needId: 'n1',
  studyId: 's1',
  token: 'tok',
  isActive: true,
  expiresAt: null as Date | null,
  org: { isActive: true },
  ...over,
});
const challenge = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  surveyLinkId: 'l1',
  contact: 'a@b.test',
  mobile: '+966512345678',
  codeHash: 'hash',
  attempts: 0,
  expiresAt: new Date(Date.now() + 60_000),
  verifiedAt: null as Date | null,
  consumedAt: null as Date | null,
  ...over,
});

function setup(cfg: Record<string, unknown> = { nodeEnv: 'development' }) {
  const tx = {
    publicSurveyLink: { findUnique: vi.fn().mockResolvedValue(link()) },
    study: { findUnique: vi.fn().mockResolvedValue({ title: 'Study' }) },
    organisation: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme', regionId: 'r1' }) },
    surveyResponse: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    citizenOtpChallenge: {
      create: vi.fn().mockResolvedValue({ id: 'c1' }),
      findUnique: vi.fn().mockResolvedValue(challenge()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    survey: {
      findFirst: vi.fn().mockResolvedValue({ id: 'sv1', surveyQuestions: [{ id: 'sq1' }] }),
    },
    need: {
      findUnique: vi.fn().mockResolvedValue({
        title: 'Water',
        village: ['V'],
        needGovernorates: [{ governorateId: 'g1' }],
        needCenters: [{ centerId: 'c1' }],
      }),
    },
  };
  const tenant = {
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsOrg: async (_o: string, fn: (t: unknown) => unknown) => fn(tx),
  };
  const passwords = {
    hash: vi.fn().mockResolvedValue('hashed'),
    verify: vi.fn().mockResolvedValue(true),
  };
  const sms = { sendOtpCode: vi.fn().mockResolvedValue(true) };
  const surveys = { getPublishedSurveyByNeedId: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const scoring = { scoreResponse: vi.fn().mockResolvedValue(undefined) };
  const rollup = { calculateRollups: vi.fn().mockResolvedValue(undefined) };
  const sessions = {
    start: vi.fn().mockResolvedValue({ sessionId: 's' }),
    recordEvent: vi.fn().mockResolvedValue({ ok: true }),
    linkChallenge: vi.fn(),
    markSubmitted: vi.fn(),
  };
  const consent = {
    getActiveCitizenPolicy: vi.fn().mockResolvedValue({ version: '2.0', text: 'x', textAr: null }),
  };
  const cleaning = { cleanSurveyResponse: vi.fn().mockResolvedValue(undefined) };
  const svc = new CitizenService(
    tenant as never,
    passwords as never,
    sms as never,
    surveys as never,
    audit as never,
    scoring as never,
    rollup as never,
    sessions as never,
    consent as never,
    cleaning as never,
    cfg as never,
  );
  return { svc, tx, passwords, sms, surveys, audit, scoring, rollup, sessions, consent, cleaning };
}

const question = (over: Record<string, unknown> = {}) => ({
  id: 'q1',
  questionText: 'Q',
  questionTextAr: null,
  answerType: 'select',
  answerOptions: ['a', 'b'],
  answerOptionsAr: ['أ', 'ب'],
  isRequired: true,
  ...over,
});

describe('CitizenService.resolveSurvey', () => {
  it('returns the survey with citizen-friendly question types and an estimated time', async () => {
    const { svc, surveys } = setup();
    surveys.getPublishedSurveyByNeedId.mockResolvedValue({
      id: 'sv1',
      title: 'Survey',
      questions: [
        question(),
        question({ id: 'q2', answerType: 'multiple_choice' }),
        question({ id: 'q3', answerType: 'checkbox' }),
        question({ id: 'q4', answerType: 'boolean', answerOptions: null, answerOptionsAr: null }),
        question({ id: 'q5', answerType: 'yes_no' }),
        question({ id: 'q6', answerType: 'rating', answerOptions: null }),
        question({ id: 'q7', answerType: 'rating' }),
        question({ id: 'q8', answerType: 'long_text' }),
        question({ id: 'q9', answerType: 'select', answerOptions: null, answerOptionsAr: null }),
      ],
    });
    const result = await svc.resolveSurvey('tok');
    expect(result.questions.map((q) => q.type)).toEqual([
      'single_choice',
      'single_choice',
      'multi_choice',
      'single_choice',
      'single_choice',
      'scale',
      'scale',
      'text',
      'single_choice',
    ]);
    expect(result.questions[3]).toMatchObject({ options: ['Yes', 'No'], optionsAr: null });
    expect(result.questions[5]).toMatchObject({ options: ['1', '2', '3', '4', '5'] });
    expect(result).toMatchObject({
      studyTitle: 'Study',
      organizationName: 'Acme',
      questionCount: 9,
      estimatedMinutes: 3,
    });
  });

  it('falls back to the survey title and an empty organization name, and 404s an unpublished survey', async () => {
    const { svc, surveys, tx } = setup();
    surveys.getPublishedSurveyByNeedId.mockResolvedValue({
      id: 'sv1',
      title: 'Survey',
      questions: [],
    });
    tx.study.findUnique.mockResolvedValue(null);
    tx.organisation.findUnique.mockResolvedValue(null);
    expect(await svc.resolveSurvey('tok')).toMatchObject({
      studyTitle: 'Survey',
      organizationName: '',
      estimatedMinutes: 1,
    });
    surveys.getPublishedSurveyByNeedId.mockResolvedValue(null);
    await expect(svc.resolveSurvey('tok')).rejects.toMatchObject({
      response: { error: { code: 'SURVEY_NOT_PUBLISHED' } },
    });
  });

  it('refuses links that are unknown, inactive, for an inactive organization, or expired', async () => {
    const { svc, tx } = setup();
    for (const found of [
      null,
      link({ isActive: false }),
      link({ org: { isActive: false } }),
      link({ org: null }),
    ]) {
      tx.publicSurveyLink.findUnique.mockResolvedValueOnce(found);
      await expect(svc.resolveSurvey('tok')).rejects.toMatchObject({
        response: { error: { code: 'SURVEY_LINK_NOT_FOUND' } },
      });
    }
    tx.publicSurveyLink.findUnique.mockResolvedValueOnce(
      link({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(svc.resolveSurvey('tok')).rejects.toMatchObject({
      response: { error: { code: 'SURVEY_LINK_EXPIRED' } },
    });
  });
});

describe('CitizenService sessions, duplicates and codes', () => {
  it('starts a session and records events for an active link', async () => {
    const { svc, sessions } = setup();
    await svc.startSession('tok');
    await svc.recordSessionEvent('tok', 'sess', { step: 'x' } as never);
    expect(sessions.start).toHaveBeenCalled();
    expect(sessions.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'l1' }),
      'sess',
      { step: 'x' },
    );
  });

  it('detects a duplicate by contact or mobile after normalising both', async () => {
    const { svc, tx } = setup();
    expect(
      await svc.checkDuplicate('tok', {
        contact: ' A@B.test ',
        mobile: '+966 (51) 234-5678',
      } as never),
    ).toEqual({ isDuplicate: false });
    expect(tx.surveyResponse.findFirst.mock.calls[0]![0].where.OR).toEqual([
      { contact: 'a@b.test' },
      { mobile: '+966512345678' },
    ]);
    tx.surveyResponse.findFirst.mockResolvedValue({ id: 'r' });
    expect(await svc.checkDuplicate('tok', { contact: 'a@b.test', mobile: '1' } as never)).toEqual({
      isDuplicate: true,
    });
  });

  it('sends a code, links it to the session, and shows it only when it could not be texted outside production', async () => {
    const { svc, sessions, sms } = setup();
    const sent = await svc.requestOtp('tok', {
      contact: 'a@b.test',
      mobile: '+966512345678',
      sessionId: 'sess',
    } as never);
    expect(sent).toMatchObject({ challengeId: 'c1', codeTexted: true, code: undefined });
    expect(sessions.linkChallenge).toHaveBeenCalledWith('org-1', 'sess', {
      id: 'c1',
      contact: 'a@b.test',
      mobile: '+966512345678',
    });
    sms.sendOtpCode.mockResolvedValue(false);
    const notSent = await svc.requestOtp('tok', {
      contact: 'a@b.test',
      mobile: '+966512345678',
    } as never);
    expect(notSent.code).toMatch(/^\d{6}$/);
    expect(sessions.linkChallenge).toHaveBeenCalledTimes(1);
    const prod = setup({ nodeEnv: 'production' });
    prod.sms.sendOtpCode.mockResolvedValue(false);
    expect(
      (await prod.svc.requestOtp('tok', { contact: 'a@b.test', mobile: '1' } as never)).code,
    ).toBeUndefined();
  });
});

describe('CitizenService.verifyOtp', () => {
  const verify = (svc: CitizenService, over: Record<string, unknown> = {}) =>
    svc.verifyOtp('tok', { challengeId: 'c1', code: '123456', ...over } as never);

  it('verifies a correct code and records the step for the session', async () => {
    const { svc, sessions } = setup();
    expect(await verify(svc, { sessionId: 'sess' })).toEqual({ verified: true });
    expect(sessions.recordEvent).toHaveBeenCalledWith(expect.anything(), 'sess', {
      step: 'OTP_VERIFIED',
    });
    expect(await verify(setup().svc)).toEqual({ verified: true });
  });

  it('accepts an already verified challenge without checking again', async () => {
    const { svc, tx, passwords } = setup();
    tx.citizenOtpChallenge.findUnique.mockResolvedValue(challenge({ verifiedAt: new Date() }));
    expect(await verify(svc)).toEqual({ verified: true });
    expect(passwords.verify).not.toHaveBeenCalled();
  });

  it('refuses an unknown, expired, exhausted, wrong or concurrently used code', async () => {
    const { svc, tx, passwords } = setup();
    tx.citizenOtpChallenge.findUnique.mockResolvedValueOnce(null);
    await expect(verify(svc)).rejects.toMatchObject({
      response: { error: { code: 'OTP_CHALLENGE_NOT_FOUND' } },
    });
    tx.citizenOtpChallenge.findUnique.mockResolvedValueOnce(challenge({ surveyLinkId: 'other' }));
    await expect(verify(svc)).rejects.toMatchObject({
      response: { error: { code: 'OTP_CHALLENGE_NOT_FOUND' } },
    });
    tx.citizenOtpChallenge.findUnique.mockResolvedValueOnce(
      challenge({ expiresAt: new Date(Date.now() - 1) }),
    );
    await expect(verify(svc)).rejects.toMatchObject({
      response: { error: { code: 'OTP_EXPIRED' } },
    });
    tx.citizenOtpChallenge.findUnique.mockResolvedValueOnce(challenge({ attempts: 5 }));
    await expect(verify(svc)).rejects.toMatchObject({
      response: { error: { code: 'OTP_TOO_MANY_ATTEMPTS' } },
    });
    passwords.verify.mockResolvedValueOnce(false);
    await expect(verify(svc)).rejects.toMatchObject({
      response: { error: { code: 'OTP_INCORRECT' } },
    });
    expect(tx.citizenOtpChallenge.updateMany.mock.calls[0]![0].data).toEqual({
      attempts: { increment: 1 },
    });
    tx.citizenOtpChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(verify(svc)).rejects.toMatchObject({
      response: { error: { message: expect.stringContaining('can no longer be used') } },
    });
  });
});

describe('CitizenService.submitResponse', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    challengeId: 'c1',
    ageBracket: 'age_25_34',
    answers: { sq1: 'yes' },
    consent: { version: '2.0', locale: 'en' },
    contactName: 'Ana',
    gender: 'female',
    sessionId: 'sess',
    ...over,
  });
  const verified = () => challenge({ verifiedAt: new Date() });

  async function submit(
    over: Record<string, unknown> = {},
    prep?: (ctx: ReturnType<typeof setup>) => void,
  ) {
    const ctx = setup();
    ctx.tx.citizenOtpChallenge.findUnique.mockResolvedValue(verified());
    ctx.tx.surveyResponse.create.mockResolvedValue({
      id: 'r1',
      studyId: 's1',
      orgId: 'org-1',
      submittedAt: new Date('2026-03-01T00:00:00Z'),
    });
    ctx.tx.surveyResponse.findUnique.mockResolvedValue({ needId: 'n1', need: { village: ['V'] } });
    prep?.(ctx);
    const result = await ctx.svc.submitResponse('tok', payload(over) as never).catch((e) => e);
    await new Promise((r) => setTimeout(r, 0));
    return { ctx, result };
  }

  it('stores the response, audits it, marks the session and starts cleaning, scoring and rollups', async () => {
    const { ctx, result } = await submit();
    expect(result).toEqual({ id: 'r1', submittedAt: '2026-03-01T00:00:00.000Z' });
    const data = ctx.tx.surveyResponse.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      contact: 'a@b.test',
      contactName: 'Ana',
      regionId: 'r1',
      governorateIds: ['g1'],
      centerIds: ['c1'],
      village: ['V'],
      consentPolicyVersion: '2.0',
    });
    expect(ctx.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'survey_response' }),
    );
    expect(ctx.sessions.markSubmitted).toHaveBeenCalledWith('org-1', 'sess', 'r1');
    expect(ctx.cleaning.cleanSurveyResponse).toHaveBeenCalledWith('r1', 'org-1');
    expect(ctx.scoring.scoreResponse).toHaveBeenCalledWith('r1', 'org-1');
    expect(ctx.rollup.calculateRollups).toHaveBeenCalledTimes(2);
  });

  it('works without optional fields, and with a need or organization that has no details', async () => {
    const { ctx, result } = await submit(
      { contactName: undefined, gender: undefined, sessionId: undefined },
      ({ tx }) => {
        tx.need.findUnique.mockResolvedValue(null);
        tx.organisation.findUnique.mockResolvedValue(null);
      },
    );
    expect(result.id).toBe('r1');
    expect(ctx.tx.surveyResponse.create.mock.calls[0]![0].data).toMatchObject({
      contactName: null,
      gender: null,
      regionId: null,
      governorateIds: [],
      village: [],
    });
    expect(ctx.sessions.markSubmitted).not.toHaveBeenCalled();
  });

  it('skips rollups when the response or survey vanished, and survives background failures', async () => {
    await submit({}, ({ tx }) => tx.surveyResponse.findUnique.mockResolvedValue(null));
    await submit({}, ({ tx }) =>
      tx.survey.findFirst
        .mockResolvedValueOnce({ id: 'sv1', surveyQuestions: [{ id: 'sq1' }] })
        .mockResolvedValueOnce(null),
    );
    const { ctx } = await submit({}, ({ cleaning, scoring }) => {
      cleaning.cleanSurveyResponse.mockRejectedValue(new Error('clean'));
      scoring.scoreResponse.mockRejectedValue(new Error('score'));
    });
    expect(ctx.tx.surveyResponse.create).toHaveBeenCalled();
    const noVillage = await submit({}, ({ tx }) =>
      tx.surveyResponse.findUnique.mockResolvedValue({ needId: 'n1', need: {} }),
    );
    expect(noVillage.ctx.rollup.calculateRollups).toHaveBeenCalledTimes(2);
  });

  it('refuses an unverified or already used code, and a stale consent notice', async () => {
    const unverified = await submit({}, ({ tx }) =>
      tx.citizenOtpChallenge.findUnique.mockResolvedValue(challenge()),
    );
    expect(unverified.result.getResponse().error.code).toBe('OTP_NOT_VERIFIED');
    const used = await submit({}, ({ tx }) =>
      tx.citizenOtpChallenge.findUnique.mockResolvedValue(
        challenge({ verifiedAt: new Date(), consumedAt: new Date() }),
      ),
    );
    expect(used.result.getResponse().error.code).toBe('OTP_ALREADY_USED');
    const stale = await submit({ consent: { version: '1.0', locale: 'en' } });
    expect(stale.result.getResponse().error).toMatchObject({
      code: 'CONSENT_VERSION_STALE',
      details: { submittedVersion: '1.0', currentVersion: '2.0' },
    });
  });

  it('refuses when the code was claimed meanwhile, on a duplicate, an unpublished survey or a changed survey', async () => {
    const claimed = await submit({}, ({ tx }) =>
      tx.citizenOtpChallenge.updateMany.mockResolvedValue({ count: 0 }),
    );
    expect(claimed.result.getResponse().error.code).toBe('OTP_ALREADY_USED');
    const dup = await submit({}, ({ tx }) =>
      tx.surveyResponse.findFirst.mockResolvedValue({ id: 'x' }),
    );
    expect(dup.result.getResponse().error.code).toBe('DUPLICATE_SUBMISSION');
    const noMobile = await submit({}, ({ tx }) =>
      tx.citizenOtpChallenge.findUnique.mockResolvedValue(
        challenge({ verifiedAt: new Date(), mobile: null }),
      ),
    );
    expect(noMobile.result.id).toBe('r1');
    const unpublished = await submit({}, ({ tx }) => tx.survey.findFirst.mockResolvedValue(null));
    expect(unpublished.result.getResponse().error.code).toBe('SURVEY_NOT_PUBLISHED');
    const changed = await submit({ answers: { old: 'x' } });
    expect(changed.result.getResponse().error.code).toBe('SURVEY_VERSION_CHANGED');
    const none = await submit({ answers: undefined });
    expect(none.result.id).toBe('r1');
    const arrayAnswers = await submit({ answers: ['a'] as never }, ({ tx }) =>
      tx.survey.findFirst.mockResolvedValue({ id: 'sv1', surveyQuestions: [{ id: '0' }] }),
    );
    expect(arrayAnswers.ctx.audit.record.mock.calls[0]![0].changes[1].after).toBe(1);
  });
});
