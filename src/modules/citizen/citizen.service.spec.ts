import { GoneException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CitizenService } from './citizen.service';

function makeService(challenge: Record<string, unknown>) {
  const fakeTx = {
    publicSurveyLink: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'link1', orgId: 'org1', needId: 'need1', studyId: 'study1',
        isActive: true, expiresAt: null, org: { isActive: true },
      }),
    },
    citizenOtpChallenge: {
      findUnique: vi.fn().mockResolvedValue(challenge),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const tenant = {
    runAsSupervisor: (cb: (tx: unknown) => unknown) => cb(fakeTx),
    runAsOrg: (_org: string, cb: (tx: unknown) => unknown) => cb(fakeTx),
    runInOrgContext: (cb: (tx: unknown) => unknown) => cb(fakeTx),
  };
  const noop = {} as never;
  return new CitizenService(
    tenant as never,
    { encryptionKey: 'x'.repeat(32) } as never, // config
    noop, // passwords
    noop, // sms
    noop, // surveys
    { record: vi.fn(), recordWithTx: vi.fn() } as never, // audit
    noop, // scoringEngine
    noop, // rollupService
  );
}

describe('CitizenService.submitResponse OTP expiry (GAP-10)', () => {
  it('rejects a verified but expired challenge before writing a response', async () => {
    const svc = makeService({
      id: 'ch1', surveyLinkId: 'link1', verifiedAt: new Date(), consumedAt: null,
      expiresAt: new Date(Date.now() - 60_000), attempts: 0,
      contact: 'a@b.co', mobile: null, codeHash: 'h',
    });
    await expect(
      svc.submitResponse('tok', { challengeId: 'ch1', answers: [], ageBracket: 'adult' } as never),
    ).rejects.toBeInstanceOf(GoneException);
  });
});
