import { GoneException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CitizenService } from './citizen.service';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const BLIND_INDEX_KEY = Buffer.alloc(32, 9).toString('base64');

// Reads the `where` clause of a mock's most recent call — a small typed
// helper so each call site doesn't repeat the `mock.calls[0][0]` cast
// (which noUncheckedIndexedAccess flags as possibly-undefined).
function lastWhereArg(mockFn: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = mockFn.mock.calls.at(-1) as [{ where: Record<string, unknown> }] | undefined;
  if (!call) throw new Error('Expected mock to have been called at least once');
  return call[0].where;
}

function makeFakeTx(overrides: { surveyResponseFindFirst?: unknown } = {}) {
  return {
    publicSurveyLink: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'link1', orgId: 'org1', needId: 'need1', studyId: 'study1',
        isActive: true, expiresAt: null, org: { isActive: true },
      }),
    },
    citizenOtpChallenge: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    surveyResponse: {
      findFirst: vi.fn().mockResolvedValue(overrides.surveyResponseFindFirst ?? null),
    },
  };
}

function makeService(challenge: Record<string, unknown>, fakeTx = makeFakeTx()) {
  (fakeTx.citizenOtpChallenge.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(challenge);
  const tenant = {
    runAsSupervisor: (cb: (tx: unknown) => unknown) => cb(fakeTx),
    runAsOrg: (_org: string, cb: (tx: unknown) => unknown) => cb(fakeTx),
    runInOrgContext: (cb: (tx: unknown) => unknown) => cb(fakeTx),
  };
  const noop = {} as never;
  return {
    svc: new CitizenService(
      tenant as never,
      { encryptionKey: ENCRYPTION_KEY, blindIndexKey: BLIND_INDEX_KEY } as never, // config
      noop, // passwords
      noop, // sms
      noop, // surveys
      { record: vi.fn(), recordWithTx: vi.fn() } as never, // audit
    ),
    fakeTx,
  };
}

describe('CitizenService.submitResponse OTP expiry (GAP-10)', () => {
  it('rejects a verified but expired challenge before writing a response', async () => {
    const { svc } = makeService({
      id: 'ch1', surveyLinkId: 'link1', verifiedAt: new Date(), consumedAt: null,
      expiresAt: new Date(Date.now() - 60_000), attempts: 0,
      contact: 'a@b.co', mobile: null, codeHash: 'h',
    });
    await expect(
      svc.submitResponse('tok', { challengeId: 'ch1', answers: [], ageBracket: 'adult' } as never),
    ).rejects.toBeInstanceOf(GoneException);
  });
});

describe('CitizenService.checkDuplicate (GAP-03 blind index)', () => {
  it('queries by contactBlindIndex/mobileBlindIndex, not the ciphertext columns', async () => {
    const { svc, fakeTx } = makeService({});
    await svc.checkDuplicate('tok', { contact: 'A@B.co ', mobile: '+1 (234) 567-890' });

    expect(fakeTx.surveyResponse.findFirst).toHaveBeenCalledTimes(1);
    const where = lastWhereArg(fakeTx.surveyResponse.findFirst);
    expect(where.needId).toBe('need1');
    expect(where).not.toHaveProperty('contact');
    expect(where).not.toHaveProperty('mobile');
    const orClause = where.OR as Array<Record<string, string>>;
    const [contactClause, mobileClause] = orClause as [Record<string, string>, Record<string, string>];
    expect(contactClause).toHaveProperty('contactBlindIndex');
    expect(contactClause.contactBlindIndex).toMatch(/^[0-9a-f]{64}$/);
    expect(mobileClause).toHaveProperty('mobileBlindIndex');
    expect(mobileClause.mobileBlindIndex).toMatch(/^[0-9a-f]{64}$/);
    // Not the raw/ciphertext value.
    expect(contactClause.contactBlindIndex).not.toBe('A@B.co ');
  });

  it('omits mobileBlindIndex from OR when no mobile is provided', async () => {
    const { svc, fakeTx } = makeService({});
    await svc.checkDuplicate('tok', { contact: 'a@b.co', mobile: '' });

    const where = lastWhereArg(fakeTx.surveyResponse.findFirst);
    expect((where.OR as unknown[]).length).toBe(1);
  });
});

describe('CitizenService.submitResponse dedup (GAP-03 fix: blind index, not plaintext-vs-ciphertext)', () => {
  const verifiedChallenge = {
    id: 'ch1', surveyLinkId: 'link1', verifiedAt: new Date(), consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000), attempts: 0,
    contact: 'a@b.co', mobile: '+1234567890', codeHash: 'h',
  };

  it('queries the belt-and-suspenders dedup by blind index, not challenge.contact/mobile directly', async () => {
    const { svc, fakeTx } = makeService(verifiedChallenge);
    // No published survey ⇒ throws after the dedup query runs, which is fine —
    // we only need to inspect the findFirst call the dedup check made.
    await expect(
      svc.submitResponse('tok', { challengeId: 'ch1', answers: {}, ageBracket: 'adult' } as never),
    ).rejects.toBeTruthy();

    expect(fakeTx.surveyResponse.findFirst).toHaveBeenCalledTimes(1);
    const where = lastWhereArg(fakeTx.surveyResponse.findFirst);
    expect(where).not.toHaveProperty('contact');
    expect(where).not.toHaveProperty('mobile');
    const orClause = where.OR as Array<Record<string, string>>;
    const [contactClause, mobileClause] = orClause as [Record<string, string>, Record<string, string>];
    expect(contactClause).toHaveProperty('contactBlindIndex');
    expect(contactClause.contactBlindIndex).toMatch(/^[0-9a-f]{64}$/);
    expect(mobileClause).toHaveProperty('mobileBlindIndex');
    expect(mobileClause.mobileBlindIndex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects as a duplicate when the blind index already matches an existing response', async () => {
    const fakeTx = makeFakeTx({ surveyResponseFindFirst: { id: 'existing-response' } });
    const { svc } = makeService(verifiedChallenge, fakeTx);

    await expect(
      svc.submitResponse('tok', { challengeId: 'ch1', answers: {}, ageBracket: 'adult' } as never),
    ).rejects.toMatchObject({
      response: { error: { code: 'DUPLICATE_SUBMISSION' } },
    });
  });
});
