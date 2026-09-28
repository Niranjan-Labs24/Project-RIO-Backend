import { describe, expect, it, vi } from 'vitest';
import { makeFakeTx } from '../../../test/support/fake-tx';
import { orgContext } from '../../tenancy/org-context';

const assess = vi.hoisted(() => vi.fn());
vi.mock('./response-quality.placeholder', () => ({ assessResponseQuality: assess }));

import { ResponseQualityService } from './response-quality.service';

function setup() {
  const tx = makeFakeTx();
  const call = async (fn: (t: unknown) => unknown) => fn(tx);
  const tenant = { runRead: call, runInOrgContext: call };
  const config = { getRaw: vi.fn().mockResolvedValue({ confidenceFlagSettings: { a: 1 } }) };
  return { tx, config, svc: new ResponseQualityService(tenant as never, config as never) };
}
const as = <T>(fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u' }, fn);
const code = (c: string) =>
  expect.objectContaining({ response: { error: expect.objectContaining({ code: c }) } });
const stored = () => ({
  id: 'r1',
  needId: 'n1',
  studyId: 's1',
  surveyLinkId: null,
  surveyResponseId: 'sr',
  completenessScore: 1,
  missingFields: [],
  confidenceFlag: 'ok',
  isDuplicate: false,
  duplicateOfId: null,
  assessedAt: new Date('2026-01-01T00:00:00Z'),
});

describe('ResponseQualityService', () => {
  it('assesses the responses of a need and stores one result per response', async () => {
    const { svc, tx, config } = setup();
    tx.need.findUnique.mockResolvedValue({ id: 'n1', studyId: 's1' });
    tx.surveyResponse.findMany.mockResolvedValue([{ id: 'sr', answers: {}, contact: null }]);
    assess.mockReturnValue([
      {
        surveyResponseId: 'sr',
        completenessScore: 1,
        missingFields: [],
        confidenceFlag: 'ok',
        isDuplicate: false,
        duplicateOfId: null,
      },
    ]);
    tx.responseQualityResult.create.mockResolvedValue(stored());
    const out = await as(() => svc.assess('n1'));
    expect(out[0]).toMatchObject({ id: 'r1', assessedAt: '2026-01-01T00:00:00.000Z' });
    expect(assess).toHaveBeenCalledWith([{ id: 'sr', answers: {}, contact: null }], { a: 1 });
    expect(config.getRaw).toHaveBeenCalled();
  });

  it('scopes to one survey link when given, and checks the link belongs to the need', async () => {
    const { svc, tx } = setup();
    tx.need.findUnique.mockResolvedValue({ id: 'n1', studyId: 's1' });
    tx.publicSurveyLink.findUnique.mockResolvedValue({ id: 'l1', needId: 'n1' });
    assess.mockReturnValue([]);
    await as(() => svc.assess('n1', 'l1'));
    expect(tx.surveyResponse.findMany.mock.calls[0]![0].where).toEqual({
      needId: 'n1',
      surveyLinkId: 'l1',
    });
    tx.publicSurveyLink.findUnique.mockResolvedValue({ id: 'l1', needId: 'other' });
    await expect(as(() => svc.assess('n1', 'l1'))).rejects.toThrow(code('SURVEY_LINK_NOT_FOUND'));
    tx.publicSurveyLink.findUnique.mockResolvedValue(null);
    await expect(as(() => svc.listForNeed('n1', 'l1'))).rejects.toThrow(
      code('SURVEY_LINK_NOT_FOUND'),
    );
  });

  it('lists stored results, and refuses an unknown need', async () => {
    const { svc, tx } = setup();
    await expect(as(() => svc.listForNeed('n1'))).rejects.toThrow(code('NEED_NOT_FOUND'));
    tx.need.findUnique.mockResolvedValue({ id: 'n1' });
    tx.responseQualityResult.findMany.mockResolvedValue([stored()]);
    expect(await as(() => svc.listForNeed('n1'))).toHaveLength(1);
    expect(tx.responseQualityResult.findMany.mock.calls[0]![0].where).toEqual({
      needId: 'n1',
      surveyLinkId: null,
    });
  });
});
