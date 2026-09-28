import { describe, expect, it, vi } from 'vitest';
import { makeFakeTx } from '../../../test/support/fake-tx';
import { SurveySessionsService } from './survey-sessions.service';

function setup() {
  const tx = makeFakeTx();
  const call = async (fn: (t: unknown) => unknown) => fn(tx);
  const tenant = {
    runAsSupervisor: vi.fn(call),
    runAsOrg: vi.fn((_o: string, fn: (t: unknown) => unknown) => call(fn)),
  };
  const config = { surveyAbandonmentIdleMinutes: 30 };
  return { tx, tenant, svc: new SurveySessionsService(tenant as never, config as never) };
}
const link = { id: 'l1', orgId: 'o1', needId: 'n1', studyId: 's1' };
const at = (iso: string) => new Date(iso);

describe('SurveySessionsService', () => {
  it('exposes the configured idle window', () => {
    expect(setup().svc.idleMinutes).toBe(30);
  });

  it('opens a session against the published survey, or with none when there is no published survey', async () => {
    const { svc, tx } = setup();
    tx.survey.findFirst.mockResolvedValueOnce({ id: 'sv1', _count: { surveyQuestions: 4 } });
    tx.surveySession.create.mockResolvedValue({ id: 'ss1' });
    expect(await svc.start(link)).toEqual({ sessionId: 'ss1' });
    expect(tx.surveySession.create.mock.calls[0]![0].data).toMatchObject({
      surveyId: 'sv1',
      questionCount: 4,
    });
    tx.survey.findFirst.mockResolvedValueOnce(null);
    await svc.start(link);
    expect(tx.surveySession.create.mock.calls[1]![0].data).toMatchObject({
      surveyId: null,
      questionCount: 0,
    });
  });

  it('never lets a tracking failure surface', async () => {
    const { svc, tx } = setup();
    tx.survey.findFirst.mockRejectedValue(new Error('db'));
    expect(await svc.start(link)).toBeNull();
    tx.surveySession.findFirst.mockRejectedValue(new Error('db'));
    expect(await svc.recordEvent(link, 'ss1', { step: 'ANSWERING' } as never)).toEqual({
      recorded: false,
    });
    tx.surveySession.updateMany.mockRejectedValue(new Error('db'));
    await svc.linkChallenge('o1', 'ss1', { id: 'c', contact: 'x', mobile: null });
    await svc.markSubmitted('o1', 'ss1', 'r1');
  });

  it('records an advancing step with its event and the highest answered watermark', async () => {
    const { svc, tx } = setup();
    tx.surveySession.findFirst.mockResolvedValue({
      id: 'ss1',
      furthestStep: 'OPENED',
      answeredCount: 5,
      submittedAt: null,
    });
    expect(
      await svc.recordEvent(link, 'ss1', {
        step: 'ANSWERING',
        answeredCount: 2,
        position: 3,
      } as never),
    ).toEqual({ recorded: true });
    const data = tx.surveySession.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({ status: 'VERIFIED', furthestStep: 'ANSWERING', answeredCount: 5 });
    expect(tx.surveySessionEvent.create.mock.calls[0]![0].data).toMatchObject({
      step: 'ANSWERING',
      position: 3,
    });
  });

  it('does not move backwards or log an event when the step does not advance', async () => {
    const { svc, tx } = setup();
    tx.surveySession.findFirst.mockResolvedValue({
      id: 'ss1',
      furthestStep: 'REVIEW',
      answeredCount: 1,
      submittedAt: null,
    });
    await svc.recordEvent(link, 'ss1', { step: 'OPENED' } as never);
    const data = tx.surveySession.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({ status: 'IN_PROGRESS' });
    expect(data).not.toHaveProperty('furthestStep');
    expect(data).not.toHaveProperty('answeredCount');
    expect(tx.surveySessionEvent.create).not.toHaveBeenCalled();
  });

  it('ignores an unknown or already submitted session', async () => {
    const { svc, tx } = setup();
    expect(await svc.recordEvent(link, 'x', { step: 'ANSWERING' } as never)).toEqual({
      recorded: false,
    });
    tx.surveySession.findFirst.mockResolvedValue({
      id: 'ss1',
      furthestStep: 'OPENED',
      answeredCount: 0,
      submittedAt: new Date(),
    });
    expect(await svc.recordEvent(link, 'ss1', { step: 'ANSWERING' } as never)).toEqual({
      recorded: false,
    });
  });

  it('records the OTP contact and the final submission', async () => {
    const { svc, tx } = setup();
    await svc.linkChallenge('o1', 'ss1', { id: 'c', contact: 'x@y.z', mobile: '1' });
    expect(tx.surveySession.updateMany.mock.calls[0]![0].data).toMatchObject({
      otpChallengeId: 'c',
      furthestStep: 'OTP_REQUESTED',
    });
    await svc.markSubmitted('o1', 'ss1', 'r1');
    expect(tx.surveySession.updateMany.mock.calls[1]![0].data).toMatchObject({
      status: 'SUBMITTED',
      surveyResponseId: 'r1',
    });
  });

  it('marks stale sessions abandoned per organisation and keeps going after a failure', async () => {
    const { svc, tx, tenant } = setup();
    expect(await svc.sweepAbandoned(at('2026-01-01T12:00:00Z'))).toBe(0);
    tx.surveySession.findMany.mockResolvedValue([
      { id: 'a', orgId: 'o1' },
      { id: 'b', orgId: 'o1' },
      { id: 'c', orgId: 'o2' },
    ]);
    tx.surveySession.updateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockRejectedValueOnce(new Error('db'));
    expect(await svc.sweepAbandoned(at('2026-01-01T12:00:00Z'))).toBe(2);
    expect(tenant.runAsOrg).toHaveBeenCalledTimes(2);
    expect(tx.surveySession.findMany.mock.calls[1]![0].where.lastEventAt.lt).toEqual(
      at('2026-01-01T11:30:00Z'),
    );
    tx.surveySession.findMany.mockResolvedValue([{ id: 'a', orgId: 'o1' }]);
    tx.surveySession.updateMany.mockResolvedValue({ count: 1 });
    await svc.sweepAbandoned();
  });

  it('loads sessions for a report, optionally for one survey, and classifies abandonment', async () => {
    const { svc, tx } = setup();
    const session = {
      id: 's',
      surveyId: 'sv',
      furthestStep: 'ANSWERING',
      questionCount: 3,
      answeredCount: 1,
      startedAt: at('2026-01-01T00:00:00Z'),
      lastEventAt: at('2026-01-01T00:10:00Z'),
      submittedAt: null,
      remindersSent: 0,
    };
    tx.surveySession.findMany.mockResolvedValue([session]);
    expect(await svc.loadSessionsForReport({ studyId: 's1' })).toHaveLength(1);
    await svc.loadSessionsForReport({ studyId: 's1', surveyId: 'sv' });
    expect(tx.surveySession.findMany.mock.calls[1]![0].where).toEqual({
      studyId: 's1',
      surveyId: 'sv',
    });
    expect(svc.isAbandoned(session as never, at('2026-01-02T00:00:00Z'))).toBe(true);
    expect(svc.isAbandoned(session as never, at('2026-01-01T00:11:00Z'))).toBe(false);
    expect(svc.isAbandoned(session as never)).toBe(true);
  });
});
