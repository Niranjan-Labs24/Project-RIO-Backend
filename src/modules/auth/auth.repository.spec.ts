import { Prisma } from '../../generated/prisma';
import { AuthRepository, UniqueConstraintError } from './auth.repository';

describe('AuthRepository', () => {
  it('finds an organisation by registration number with a plain, unscoped query', async () => {
    const org = { id: 'org_1', name: 'Demo', purpose: 'Health', registrationNumber: 'REG-1' };
    const prisma = {
      organisation: { findUnique: vi.fn().mockResolvedValue(org) },
    };
    const repo = new AuthRepository(prisma as never);

    const result = await repo.findOrganisationByRegistrationNumber('REG-1');

    expect(result).toEqual(org);
    expect(prisma.organisation.findUnique).toHaveBeenCalledWith({
      where: { registrationNumber: 'REG-1' },
      select: { id: true, name: true, purpose: true, registrationNumber: true },
    });
  });

  it('sets the auth-lookup GUC before finding a user by email', async () => {
    const user = {
      id: 'user_1',
      orgId: 'org_1',
      name: 'Priya',
      email: 'priya@demo.org',
      passwordHash: 'hash',
      role: 'ngo_admin',
    };
    const calls: string[] = [];
    const tx = {
      $executeRaw: vi.fn().mockImplementation(() => {
        calls.push('set_config');
        return Promise.resolve();
      }),
      user: {
        findUnique: vi.fn().mockImplementation(() => {
          calls.push('findUnique');
          return Promise.resolve(user);
        }),
      },
    };
    const prisma = { $transaction: (fn: (tx: unknown) => unknown) => fn(tx) };
    const repo = new AuthRepository(prisma as never);

    const result = await repo.findUserByEmailForAuth('priya@demo.org');

    expect(result).toEqual(user);
    // The GUC must be set before the lookup runs, in the same transaction.
    expect(calls).toEqual(['set_config', 'findUnique']);
  });

  it('creates an organisation, sets its id as the org context, then creates the admin user', async () => {
    const organisation = {
      id: 'org_new',
      name: 'New Org',
      purpose: 'Education',
      registrationNumber: 'REG-NEW',
    };
    const user = {
      id: 'user_new',
      orgId: 'org_new',
      name: 'Admin',
      email: 'admin@new-org.org',
      passwordHash: 'hash',
      role: 'ngo_admin',
    };
    const calls: string[] = [];
    let orgContextValue: string | undefined;
    const tx = {
      organisation: {
        create: vi.fn().mockImplementation(() => {
          calls.push('organisation.create');
          return Promise.resolve(organisation);
        }),
      },
      $executeRaw: vi.fn().mockImplementation((_strings: unknown, orgId: string) => {
        calls.push('set_config');
        orgContextValue = orgId;
        return Promise.resolve();
      }),
      user: {
        create: vi.fn().mockImplementation(() => {
          calls.push('user.create');
          return Promise.resolve(user);
        }),
      },
    };
    const prisma = { $transaction: (fn: (tx: unknown) => unknown) => fn(tx) };
    const repo = new AuthRepository(prisma as never);

    const result = await repo.createOrganisationAndAdmin({
      organizationName: 'New Org',
      purpose: 'Education',
      registrationNumber: 'REG-NEW',
      adminName: 'Admin',
      email: 'admin@new-org.org',
      passwordHash: 'hash',
    });

    expect(result).toEqual({ organisation, user });
    // Org created first, then its id set as the org context, then the user
    // insert — in that order, so the user row satisfies users_org_isolation.
    expect(calls).toEqual(['organisation.create', 'set_config', 'user.create']);
    expect(orgContextValue).toBe('org_new');
  });

  it('normalizes registration number (trim + uppercase) before the lookup', async () => {
    const prisma = {
      organisation: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const repo = new AuthRepository(prisma as never);

    await repo.findOrganisationByRegistrationNumber('  reg-demo-0001  ');

    expect(prisma.organisation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { registrationNumber: 'REG-DEMO-0001' } }),
    );
  });

  it('normalizes email (trim + lowercase) before the auth-lookup query', async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const prisma = { $transaction: (fn: (tx: unknown) => unknown) => fn(tx) };
    const repo = new AuthRepository(prisma as never);

    await repo.findUserByEmailForAuth('  Priya@Demo.ORG  ');

    expect(tx.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'priya@demo.org' } }),
    );
  });

  it('normalizes both fields before creating an organisation + admin', async () => {
    const tx = {
      organisation: {
        create: vi.fn().mockResolvedValue({
          id: 'org_1',
          name: 'New Org',
          purpose: 'X',
          registrationNumber: 'REG-NEW',
        }),
      },
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      user: {
        create: vi.fn().mockResolvedValue({
          id: 'user_1',
          orgId: 'org_1',
          name: 'Admin',
          email: 'admin@new-org.org',
          passwordHash: 'hash',
          role: 'ngo_admin',
        }),
      },
    };
    const prisma = { $transaction: (fn: (tx: unknown) => unknown) => fn(tx) };
    const repo = new AuthRepository(prisma as never);

    await repo.createOrganisationAndAdmin({
      organizationName: 'New Org',
      purpose: 'X',
      registrationNumber: '  reg-new  ',
      adminName: 'Admin',
      email: '  Admin@New-Org.ORG  ',
      passwordHash: 'hash',
    });

    expect(tx.organisation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ registrationNumber: 'REG-NEW' }) }),
    );
    expect(tx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'admin@new-org.org' }) }),
    );
  });

  it('converts a unique-constraint race on registration number into UniqueConstraintError', async () => {
    const violation = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['registration_number'] },
    });
    const prisma = {
      $transaction: () => Promise.reject(violation),
    };
    const repo = new AuthRepository(prisma as never);

    const error = await repo
      .createOrganisationAndAdmin({
        organizationName: 'New Org',
        purpose: 'X',
        registrationNumber: 'REG-NEW',
        adminName: 'Admin',
        email: 'admin@new-org.org',
        passwordHash: 'hash',
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect((error as UniqueConstraintError).field).toBe('registrationNumber');
  });

  it('converts a unique-constraint race on email into UniqueConstraintError', async () => {
    const violation = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['email'] },
    });
    const prisma = {
      $transaction: () => Promise.reject(violation),
    };
    const repo = new AuthRepository(prisma as never);

    const error = await repo
      .createOrganisationAndAdmin({
        organizationName: 'New Org',
        purpose: 'X',
        registrationNumber: 'REG-NEW',
        adminName: 'Admin',
        email: 'admin@new-org.org',
        passwordHash: 'hash',
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect((error as UniqueConstraintError).field).toBe('email');
  });

  it('rethrows non-unique-constraint errors unchanged', async () => {
    const otherError = new Error('connection lost');
    const prisma = {
      $transaction: () => Promise.reject(otherError),
    };
    const repo = new AuthRepository(prisma as never);

    const error = await repo
      .createOrganisationAndAdmin({
        organizationName: 'New Org',
        purpose: 'X',
        registrationNumber: 'REG-NEW',
        adminName: 'Admin',
        email: 'admin@new-org.org',
        passwordHash: 'hash',
      })
      .catch((e: unknown) => e);

    expect(error).toBe(otherError);
  });

  it('updatePassword sets the org context before updating, and clears mustChangePassword', async () => {
    const updatedUser = {
      id: 'user_1',
      orgId: 'org_1',
      name: 'Priya',
      email: 'priya@demo.org',
      passwordHash: 'new-hash',
      role: 'ngo_admin',
      mustChangePassword: false,
    };
    const calls: string[] = [];
    let orgContextValue: string | undefined;
    const tx = {
      $executeRaw: vi.fn().mockImplementation((_strings: unknown, orgId: string) => {
        calls.push('set_config');
        orgContextValue = orgId;
        return Promise.resolve();
      }),
      user: {
        update: vi.fn().mockImplementation(() => {
          calls.push('user.update');
          return Promise.resolve(updatedUser);
        }),
      },
    };
    const prisma = { $transaction: (fn: (tx: unknown) => unknown) => fn(tx) };
    const repo = new AuthRepository(prisma as never);

    const result = await repo.updatePassword('user_1', 'org_1', 'new-hash');

    expect(result).toEqual(updatedUser);
    expect(calls).toEqual(['set_config', 'user.update']);
    expect(orgContextValue).toBe('org_1');
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_1' },
        data: { passwordHash: 'new-hash', mustChangePassword: false },
      }),
    );
  });
});
