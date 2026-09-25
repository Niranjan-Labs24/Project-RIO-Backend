import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { orgContext } from '../../tenancy/org-context';
import { PasswordService } from '../../auth/password.service';
import { TokenService } from '../../auth/token.service';
import { AuthService } from './auth.service';

const passwords = new PasswordService();
const tokens = new TokenService(
  new JwtService({ secret: 'x'.repeat(32), signOptions: { expiresIn: '12h' } }),
);

const org = {
  id: 'o1',
  name: 'Demo NGO',
  logoUrl: null,
  region: ['N'],
  email: 'a@demo.org',
  sector: 'wash',
  villages: ['A'],
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  purpose: 'p',
  registrationNumber: 'RN',
  regionId: null,
  orgGovernorates: [{ governorateId: 'g1' }],
  orgCenters: [{ centerId: 'c1' }],
};

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    name: 'Ana',
    email: 'ana@demo.org',
    mobileNumber: '+966512345678',
    roleId: 'role_ngo_admin',
    passwordHash: 'hash',
    status: 'active',
    consentedAt: null,
    consentedPolicyVersion: null,
    sharingConsentedAt: null,
    sharingConsentedPolicyVersion: null,
    sessionVersion: 3,
    mustChangePassword: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    org,
    ...over,
  };
}

function setup(cfg: Record<string, unknown> = {}) {
  const tx = {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: 'u1', email: 'ana@demo.org' }),
    },
    passwordResetToken: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    staffOtpChallenge: {
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn(),
    },
  };
  const tenant = {
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsOrg: async (_o: string, fn: (t: unknown) => unknown) => fn(tx),
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  const mailer = {
    sendPasswordResetEmail: vi.fn().mockResolvedValue(true),
    sendLoginOtpEmail: vi.fn().mockResolvedValue(true),
  };
  const sms = { sendLoginOtpCode: vi.fn().mockResolvedValue(true) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const grants = { listActiveGrantsForUser: vi.fn().mockResolvedValue([]) };
  const config = {
    nodeEnv: 'development',
    corsOrigin: 'https://app.test',
    emailOtpEnabled: true,
    ...cfg,
  };
  const svc = new AuthService(
    tenant as never,
    passwords,
    tokens,
    audit as never,
    {} as never,
    mailer as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    grants as never,
    sms as never,
  );
  return { svc, tx, mailer, sms, audit, grants };
}

const inCtx = <T>(fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'x', actorId: 'y' }, fn);

describe('AuthService.forgotPassword', () => {
  it('answers generically without doing anything for an unknown, passwordless or inactive account', async () => {
    const { svc, tx, mailer } = setup();
    tx.user.findUnique.mockResolvedValueOnce(null);
    tx.user.findUnique.mockResolvedValueOnce(userRow({ passwordHash: null }));
    tx.user.findUnique.mockResolvedValueOnce(userRow({ org: { ...org, isActive: false } }));
    for (let i = 0; i < 3; i++) {
      await expect(svc.forgotPassword({ email: 'ANA@demo.org ' })).resolves.toMatchObject({
        message: expect.stringContaining('If that email exists'),
      });
    }
    expect(mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('retires older tokens, stores a hashed one and emails the reset link', async () => {
    const { svc, tx, mailer } = setup();
    tx.user.findUnique.mockResolvedValue(userRow());
    await svc.forgotPassword({ email: 'ana@demo.org' });
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalled();
    const stored = tx.passwordResetToken.create.mock.calls[0]![0].data;
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const url = mailer.sendPasswordResetEmail.mock.calls[0]![1] as string;
    const raw = new URL(url).searchParams.get('token')!;
    expect(createHash('sha256').update(raw).digest('hex')).toBe(stored.tokenHash);
    expect(url.startsWith('https://app.test/reset-password')).toBe(true);
  });
});

describe('AuthService.resetPassword', () => {
  const token = 'raw-token';
  const tokenRow = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    orgId: 'o1',
    userId: 'u1',
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  });

  it('sets the new password, bumps the session version, consumes the token and audits', async () => {
    const { svc, tx, audit } = setup();
    tx.passwordResetToken.findUnique.mockResolvedValue(tokenRow());
    await expect(svc.resetPassword({ token, password: 'New-Passw0rd!' })).resolves.toEqual({
      message: 'Password reset.',
    });
    expect(tx.passwordResetToken.findUnique.mock.calls[0]![0].where.tokenHash).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
    const data = tx.user.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({ mustChangePassword: false, sessionVersion: { increment: 1 } });
    expect(await passwords.verify(data.passwordHash, 'New-Passw0rd!')).toBe(true);
    expect(tx.passwordResetToken.update).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'user', organizationId: 'o1' }),
    );
  });

  it('rejects an unknown, used or expired link', async () => {
    const { svc, tx } = setup();
    for (const row of [
      null,
      tokenRow({ consumedAt: new Date() }),
      tokenRow({ expiresAt: new Date(Date.now() - 1000) }),
    ]) {
      tx.passwordResetToken.findUnique.mockResolvedValueOnce(row);
      await expect(svc.resetPassword({ token, password: 'x' })).rejects.toMatchObject({
        response: { error: { code: 'INVALID_RESET_TOKEN' } },
      });
    }
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

describe('AuthService staff one-time codes', () => {
  let hash: string;
  beforeAll(async () => {
    hash = await passwords.hash('123456');
  });

  const challenge = (over: Record<string, unknown> = {}) => ({
    id: 'c1',
    codeHash: hash,
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
    ...over,
  });

  it('gives the same generic answer when the account cannot use a code', async () => {
    const { svc, tx, sms, mailer } = setup();
    tx.user.findFirst.mockResolvedValueOnce(null);
    tx.user.findFirst.mockResolvedValueOnce(userRow({ org: { ...org, isActive: false } }));
    tx.user.findFirst.mockResolvedValueOnce(userRow({ status: 'disabled' }));
    tx.user.findFirst.mockResolvedValueOnce(
      userRow({ email: 'other@demo.org', mobileNumber: null }),
    );
    for (let i = 0; i < 4; i++) {
      expect(await svc.requestLoginOtp({ identifier: '+966 51 234 5678' })).toEqual({
        message: expect.any(String),
      });
    }
    expect(sms.sendLoginOtpCode).not.toHaveBeenCalled();
    expect(mailer.sendLoginOtpEmail).not.toHaveBeenCalled();
  });

  it('sends a code by SMS to a mobile number and by email to an address', async () => {
    const { svc, tx, sms, mailer } = setup();
    tx.user.findFirst.mockResolvedValue(userRow());
    await svc.requestLoginOtp({ identifier: '+966 (51) 234-5678' });
    expect(sms.sendLoginOtpCode).toHaveBeenCalledWith(
      '+966512345678',
      expect.stringMatching(/^\d{6}$/),
    );
    await svc.requestLoginOtp({ identifier: 'ANA@demo.org' });
    expect(mailer.sendLoginOtpEmail).toHaveBeenCalledWith(
      'ana@demo.org',
      expect.stringMatching(/^\d{6}$/),
    );
    expect(tx.staffOtpChallenge.create).toHaveBeenCalledTimes(2);
  });

  it('does not email a code when email sign-in codes are switched off', async () => {
    const { svc, tx, mailer } = setup({ emailOtpEnabled: false });
    tx.user.findFirst.mockResolvedValue(userRow());
    await svc.requestLoginOtp({ identifier: 'ana@demo.org' });
    expect(mailer.sendLoginOtpEmail).not.toHaveBeenCalled();
  });

  it('reveals the code only outside production, and only when delivery failed', async () => {
    const dev = setup();
    dev.tx.user.findFirst.mockResolvedValue(userRow());
    dev.sms.sendLoginOtpCode.mockResolvedValue(false);
    expect((await dev.svc.requestLoginOtp({ identifier: '+966512345678' })).devCode).toMatch(
      /^\d{6}$/,
    );
    const prod = setup({ nodeEnv: 'production' });
    prod.tx.user.findFirst.mockResolvedValue(userRow());
    prod.sms.sendLoginOtpCode.mockResolvedValue(false);
    expect(
      (await prod.svc.requestLoginOtp({ identifier: '+966512345678' })).devCode,
    ).toBeUndefined();
  });

  it('signs the user in with a correct code and consumes it', async () => {
    const { svc, tx, audit } = setup();
    tx.user.findFirst.mockResolvedValue(userRow());
    tx.staffOtpChallenge.findFirst.mockResolvedValue(challenge());
    const session = await inCtx(() =>
      svc.verifyLoginOtp({ identifier: 'ana@demo.org', code: '123456' }),
    );
    expect(session.token).toBeTruthy();
    expect(session.organization.governorateIds).toEqual(['g1']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'login', metadata: { via: 'otp', channel: 'email' } }),
    );
  });

  it('gives center supervisors their active grants on top of the role', async () => {
    const { svc, tx, grants } = setup();
    tx.user.findFirst.mockResolvedValue(userRow({ roleId: 'role_center_supervisor' }));
    tx.staffOtpChallenge.findFirst.mockResolvedValue(challenge());
    grants.listActiveGrantsForUser.mockResolvedValue([
      { module: 'reportsDashboards', action: 'export' },
      { module: 'ncnpReport', action: 'approve' },
    ]);
    const session = await inCtx(() =>
      svc.verifyLoginOtp({ identifier: 'ana@demo.org', code: '123456' }),
    );
    const byModule = Object.fromEntries(session.role.permissions.map((p) => [p.module, p]));
    expect(byModule.reportsDashboards!.export).toBe(true);
    expect(byModule.ncnpReport!.approve).toBe(true);
  });

  it('rejects a wrong code, counting the attempt', async () => {
    const { svc, tx } = setup();
    tx.user.findFirst.mockResolvedValue(userRow());
    tx.staffOtpChallenge.findFirst.mockResolvedValue(challenge());
    await expect(
      svc.verifyLoginOtp({ identifier: 'ana@demo.org', code: '000000' }),
    ).rejects.toMatchObject({ response: { error: { code: 'OTP_INCORRECT' } } });
    expect(tx.staffOtpChallenge.updateMany.mock.calls[0]![0].data).toEqual({
      attempts: { increment: 1 },
    });
  });

  it('rejects when there is no challenge, it expired, it is out of attempts, or it was already used', async () => {
    const { svc, tx } = setup();
    tx.user.findFirst.mockResolvedValue(userRow());
    tx.staffOtpChallenge.findFirst.mockResolvedValueOnce(null);
    await expect(
      svc.verifyLoginOtp({ identifier: 'ana@demo.org', code: '123456' }),
    ).rejects.toMatchObject({ response: { error: { code: 'OTP_INCORRECT' } } });
    tx.staffOtpChallenge.findFirst.mockResolvedValueOnce(
      challenge({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(
      svc.verifyLoginOtp({ identifier: 'ana@demo.org', code: '123456' }),
    ).rejects.toMatchObject({ response: { error: { code: 'OTP_EXPIRED' } } });
    tx.staffOtpChallenge.findFirst.mockResolvedValueOnce(challenge({ attempts: 99 }));
    await expect(
      svc.verifyLoginOtp({ identifier: 'ana@demo.org', code: '123456' }),
    ).rejects.toMatchObject({ response: { error: { code: 'OTP_INCORRECT' } } });
    tx.staffOtpChallenge.findFirst.mockResolvedValueOnce(challenge());
    tx.staffOtpChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      svc.verifyLoginOtp({ identifier: 'ana@demo.org', code: '123456' }),
    ).rejects.toMatchObject({ response: { error: { code: 'OTP_INCORRECT' } } });
  });

  it('rejects an unknown account and an email code when email codes are off', async () => {
    const { svc, tx } = setup({ emailOtpEnabled: false });
    tx.user.findFirst.mockResolvedValueOnce(null);
    await expect(svc.verifyLoginOtp({ identifier: 'x@demo.org', code: '1' })).rejects.toMatchObject(
      { response: { error: { code: 'OTP_INCORRECT' } } },
    );
    tx.user.findFirst.mockResolvedValueOnce(userRow());
    await expect(
      svc.verifyLoginOtp({ identifier: 'ana@demo.org', code: '1' }),
    ).rejects.toMatchObject({ response: { error: { code: 'OTP_INCORRECT' } } });
  });

  it('refuses a user whose role is not recognised', async () => {
    const { svc, tx } = setup();
    tx.user.findFirst.mockResolvedValue(userRow({ roleId: 'role_nope' }));
    tx.staffOtpChallenge.findFirst.mockResolvedValue(challenge());
    await expect(
      inCtx(() => svc.verifyLoginOtp({ identifier: 'ana@demo.org', code: '123456' })),
    ).rejects.toMatchObject({
      response: { error: { code: 'INVALID_ROLE' } },
    });
  });
});
