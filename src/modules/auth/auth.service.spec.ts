import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { hashPassword } from '../../common/password.util';
import { signSessionToken, verifySessionToken } from '../../common/session.util';
import { AuthService } from './auth.service';
import { UniqueConstraintError, type AuthRepository } from './auth.repository';
import type { ConfigService } from '../../config/config.service';
import type { MailerService } from '../../mailer/mailer.service';

const JWT_SECRET = 'test-only-secret-at-least-32-characters-long';

function makeFakeConfig(nodeEnv: 'test' | 'production' = 'test'): ConfigService {
  return { jwtSecret: JWT_SECRET, nodeEnv } as unknown as ConfigService;
}

/** Defaults to "not configured" (no RESEND_API_KEY) — matches most existing tests' assumptions. */
function makeFakeMailer(sendTemporaryPassword = vi.fn().mockResolvedValue(false)): MailerService {
  return { sendTemporaryPassword } as unknown as MailerService;
}

const SIGNUP_INPUT = {
  organizationName: 'New Org',
  purpose: 'x',
  registrationNumber: 'REG-NEW',
  email: 'someone@new-org.org',
};

const ORGANISATION = { id: 'org_new', name: 'New Org', purpose: 'x', registrationNumber: 'REG-NEW' };
const USER = {
  id: 'user_new',
  orgId: 'org_new',
  name: 'New Org Admin',
  email: 'someone@new-org.org',
  passwordHash: 'irrelevant-hash',
  role: 'ngo_admin',
  mustChangePassword: true,
};

describe('AuthService.signup', () => {
  it('rejects a duplicate registration number with the exact required message, before touching the email check', async () => {
    const findOrganisationByRegistrationNumber = vi
      .fn()
      .mockResolvedValue({ id: 'org_1', name: 'Existing', purpose: 'x', registrationNumber: 'REG-1' });
    const findUserByEmailForAuth = vi.fn();
    const repo = {
      findOrganisationByRegistrationNumber,
      findUserByEmailForAuth,
      createOrganisationAndAdmin: vi.fn(),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer());

    await expect(
      service.signup({ ...SIGNUP_INPUT, registrationNumber: 'REG-1' }),
    ).rejects.toBeInstanceOf(ConflictException);

    // The dedup check is a hard stop — never reaches the email check or creation.
    expect(findUserByEmailForAuth).not.toHaveBeenCalled();
  });

  it('rejects a duplicate email even with a new registration number', async () => {
    const repo = {
      findOrganisationByRegistrationNumber: vi.fn().mockResolvedValue(null),
      findUserByEmailForAuth: vi.fn().mockResolvedValue({
        id: 'user_1',
        orgId: 'org_1',
        name: 'Existing',
        email: 'existing@demo.org',
        passwordHash: 'hash',
        role: 'ngo_admin',
      }),
      createOrganisationAndAdmin: vi.fn(),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer());

    await expect(
      service.signup({ ...SIGNUP_INPUT, email: 'existing@demo.org' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repo.createOrganisationAndAdmin).not.toHaveBeenCalled();
  });

  it('generates a temporary password, hashes it, and never passes a client-supplied one (there isn\'t one)', async () => {
    const createOrganisationAndAdmin = vi
      .fn()
      .mockResolvedValue({ organisation: ORGANISATION, user: USER });
    const repo = {
      findOrganisationByRegistrationNumber: vi.fn().mockResolvedValue(null),
      findUserByEmailForAuth: vi.fn().mockResolvedValue(null),
      createOrganisationAndAdmin,
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer());

    await service.signup(SIGNUP_INPUT);

    const call = createOrganisationAndAdmin.mock.calls[0][0];
    expect(call.adminName).toBe('New Org Admin');
    expect(call.email).toBe('someone@new-org.org');
    expect(typeof call.passwordHash).toBe('string');
    // A real argon2 hash, not the plaintext temp password itself.
    expect(call.passwordHash.startsWith('$argon2')).toBe(true);
  });

  it('creates the org+admin and returns a session with a valid, correctly-scoped token', async () => {
    const repo = {
      findOrganisationByRegistrationNumber: vi.fn().mockResolvedValue(null),
      findUserByEmailForAuth: vi.fn().mockResolvedValue(null),
      createOrganisationAndAdmin: vi.fn().mockResolvedValue({ organisation: ORGANISATION, user: USER }),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer());

    const session = await service.signup(SIGNUP_INPUT);

    expect(session.role.key).toBe('ngo_admin');
    expect(session.organization.registrationNumber).toBe('REG-NEW');
    expect(session.mustChangePassword).toBe(true);
    const payload = verifySessionToken(session.token, JWT_SECRET);
    expect(payload).toEqual({ sub: 'user_new', orgId: 'org_new', role: 'ngo_admin' });
  });

  it('asks the mailer to send the temporary password, with the right recipient, org name, and value', async () => {
    const sendTemporaryPassword = vi.fn().mockResolvedValue(true);
    const repo = {
      findOrganisationByRegistrationNumber: vi.fn().mockResolvedValue(null),
      findUserByEmailForAuth: vi.fn().mockResolvedValue(null),
      createOrganisationAndAdmin: vi.fn().mockResolvedValue({ organisation: ORGANISATION, user: USER }),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer(sendTemporaryPassword));

    await service.signup(SIGNUP_INPUT);

    expect(sendTemporaryPassword).toHaveBeenCalledTimes(1);
    const [to, organizationName, password] = sendTemporaryPassword.mock.calls[0];
    expect(to).toBe('someone@new-org.org');
    expect(organizationName).toBe('New Org');
    expect(typeof password).toBe('string');
    expect(password.length).toBeGreaterThan(0);
  });

  it('when the mailer sends successfully, marks temporaryPasswordEmailed and does not leak the password in the response', async () => {
    const repo = {
      findOrganisationByRegistrationNumber: vi.fn().mockResolvedValue(null),
      findUserByEmailForAuth: vi.fn().mockResolvedValue(null),
      createOrganisationAndAdmin: vi.fn().mockResolvedValue({ organisation: ORGANISATION, user: USER }),
    } as unknown as AuthRepository;
    const service = new AuthService(
      repo,
      makeFakeConfig('test'),
      makeFakeMailer(vi.fn().mockResolvedValue(true)),
    );

    const session = await service.signup(SIGNUP_INPUT);

    expect(session.temporaryPasswordEmailed).toBe(true);
    expect(session.temporaryPassword).toBeUndefined();
  });

  it('falls back to including the temporary password in the response outside production when the mailer is not configured', async () => {
    const repo = {
      findOrganisationByRegistrationNumber: vi.fn().mockResolvedValue(null),
      findUserByEmailForAuth: vi.fn().mockResolvedValue(null),
      createOrganisationAndAdmin: vi.fn().mockResolvedValue({ organisation: ORGANISATION, user: USER }),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig('test'), makeFakeMailer());

    const session = await service.signup(SIGNUP_INPUT);

    expect(session.temporaryPasswordEmailed).toBe(false);
    expect(session.temporaryPassword).toBeTruthy();
    expect(typeof session.temporaryPassword).toBe('string');
  });

  it('falls back the same way when the mailer is configured but the send fails', async () => {
    const repo = {
      findOrganisationByRegistrationNumber: vi.fn().mockResolvedValue(null),
      findUserByEmailForAuth: vi.fn().mockResolvedValue(null),
      createOrganisationAndAdmin: vi.fn().mockResolvedValue({ organisation: ORGANISATION, user: USER }),
    } as unknown as AuthRepository;
    const service = new AuthService(
      repo,
      makeFakeConfig('test'),
      makeFakeMailer(vi.fn().mockResolvedValue(false)),
    );

    const session = await service.signup(SIGNUP_INPUT);

    expect(session.temporaryPasswordEmailed).toBe(false);
    expect(session.temporaryPassword).toBeTruthy();
  });

  it('omits the temporary password from the response in production even when the mailer is not configured', async () => {
    const repo = {
      findOrganisationByRegistrationNumber: vi.fn().mockResolvedValue(null),
      findUserByEmailForAuth: vi.fn().mockResolvedValue(null),
      createOrganisationAndAdmin: vi.fn().mockResolvedValue({ organisation: ORGANISATION, user: USER }),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig('production'), makeFakeMailer());

    const session = await service.signup(SIGNUP_INPUT);

    expect(session.temporaryPasswordEmailed).toBe(false);
    expect(session.temporaryPassword).toBeUndefined();
  });

  it('converts a unique-constraint race into the same 409 the upfront check would give', async () => {
    // Both upfront checks pass clean, but the insert itself loses a race
    // to a concurrent signup — the repository signals this as
    // UniqueConstraintError rather than a raw DB error escaping.
    const repo = {
      findOrganisationByRegistrationNumber: vi.fn().mockResolvedValue(null),
      findUserByEmailForAuth: vi.fn().mockResolvedValue(null),
      createOrganisationAndAdmin: vi
        .fn()
        .mockRejectedValue(new UniqueConstraintError('registrationNumber')),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer());

    await expect(service.signup(SIGNUP_INPUT)).rejects.toMatchObject({
      response: {
        error: {
          message:
            'An administrator already exists for this organization. Please contact your organization administrator.',
        },
      },
    });
  });

  it('lets non-unique-constraint errors from the create step propagate unchanged', async () => {
    const dbOutage = new Error('connection lost');
    const repo = {
      findOrganisationByRegistrationNumber: vi.fn().mockResolvedValue(null),
      findUserByEmailForAuth: vi.fn().mockResolvedValue(null),
      createOrganisationAndAdmin: vi.fn().mockRejectedValue(dbOutage),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer());

    await expect(service.signup(SIGNUP_INPUT)).rejects.toBe(dbOutage);
  });
});

describe('AuthService.login', () => {
  it('rejects an unknown email with a generic message', async () => {
    const repo = {
      findUserByEmailForAuth: vi.fn().mockResolvedValue(null),
      findOrganisationById: vi.fn(),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer());

    await expect(
      service.login({ email: 'nobody@demo.org', password: 'password123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong password with the same generic message as an unknown email', async () => {
    const passwordHash = await hashPassword('correct-password');
    const repo = {
      findUserByEmailForAuth: vi.fn().mockResolvedValue({
        id: 'user_1',
        orgId: 'org_1',
        name: 'Someone',
        email: 'someone@demo.org',
        passwordHash,
        role: 'ngo_admin',
        mustChangePassword: false,
      }),
      findOrganisationById: vi.fn(),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer());

    await expect(
      service.login({ email: 'someone@demo.org', password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns a session for correct credentials, carrying mustChangePassword through as-is', async () => {
    const passwordHash = await hashPassword('correct-password');
    const repo = {
      findUserByEmailForAuth: vi.fn().mockResolvedValue({
        id: 'user_1',
        orgId: 'org_1',
        name: 'Someone',
        email: 'someone@demo.org',
        passwordHash,
        role: 'human_reviewer',
        mustChangePassword: true,
      }),
      findOrganisationById: vi
        .fn()
        .mockResolvedValue({ id: 'org_1', name: 'Demo', purpose: 'x', registrationNumber: 'REG-1' }),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer());

    const session = await service.login({ email: 'someone@demo.org', password: 'correct-password' });

    expect(session.role.key).toBe('human_reviewer');
    expect(session.organization.id).toBe('org_1');
    expect(session.mustChangePassword).toBe(true);
  });
});

describe('AuthService.changePassword', () => {
  const JWT_TOKEN_PAYLOAD = { sub: 'user_1', orgId: 'org_1', role: 'ngo_admin' };

  function makeToken(): string {
    return signSessionToken(JWT_TOKEN_PAYLOAD, JWT_SECRET);
  }

  it('rejects an invalid/expired session token', async () => {
    const repo = { findUserByIdForAuth: vi.fn() } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer());

    await expect(
      service.changePassword('not-a-real-token', {
        currentPassword: 'temp',
        newPassword: 'brand-new-password',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.findUserByIdForAuth).not.toHaveBeenCalled();
  });

  it('rejects an incorrect current password and never touches updatePassword', async () => {
    const passwordHash = await hashPassword('the-real-temp-password');
    const repo = {
      findUserByIdForAuth: vi.fn().mockResolvedValue({
        id: 'user_1',
        orgId: 'org_1',
        name: 'Someone',
        email: 'someone@demo.org',
        passwordHash,
        role: 'ngo_admin',
        mustChangePassword: true,
      }),
      updatePassword: vi.fn(),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer());
    const token = makeToken();

    await expect(
      service.changePassword(token, {
        currentPassword: 'wrong-temp-password',
        newPassword: 'brand-new-password',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.updatePassword).not.toHaveBeenCalled();
  });

  it('hashes the new password, persists it, and returns a session with mustChangePassword cleared', async () => {
    const passwordHash = await hashPassword('the-real-temp-password');
    const updatePassword = vi.fn().mockResolvedValue({
      id: 'user_1',
      orgId: 'org_1',
      name: 'Someone',
      email: 'someone@demo.org',
      passwordHash: 'new-hash',
      role: 'ngo_admin',
      mustChangePassword: false,
    });
    const repo = {
      findUserByIdForAuth: vi.fn().mockResolvedValue({
        id: 'user_1',
        orgId: 'org_1',
        name: 'Someone',
        email: 'someone@demo.org',
        passwordHash,
        role: 'ngo_admin',
        mustChangePassword: true,
      }),
      updatePassword,
      findOrganisationById: vi
        .fn()
        .mockResolvedValue({ id: 'org_1', name: 'Demo', purpose: 'x', registrationNumber: 'REG-1' }),
    } as unknown as AuthRepository;
    const service = new AuthService(repo, makeFakeConfig(), makeFakeMailer());
    const token = makeToken();

    const session = await service.changePassword(token, {
      currentPassword: 'the-real-temp-password',
      newPassword: 'brand-new-password',
    });

    expect(updatePassword).toHaveBeenCalledWith('user_1', 'org_1', expect.any(String));
    const newHash = updatePassword.mock.calls[0][2];
    expect(newHash.startsWith('$argon2')).toBe(true);
    expect(session.mustChangePassword).toBe(false);
    expect(session.token).toBe(token);
  });
});
