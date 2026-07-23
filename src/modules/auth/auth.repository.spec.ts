import { vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { AuthRepository } from './auth.repository';
import { Prisma } from '../../generated/prisma';

function tenantMock() {
  const tx = {
    organisation: { create: vi.fn(), findFirst: vi.fn() },
    user: { create: vi.fn(), findUnique: vi.fn() },
  };
  return {
    tx,
    tenant: {
      runAsOrg: vi.fn(async (_orgId: string, fn: (t: typeof tx) => unknown) => fn(tx)),
      runAsSupervisor: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
}

describe('AuthRepository.createOrganisationAndAdmin', () => {
  it('creates org + ngo_admin (no consent — that happens post-login) and returns both rows', async () => {
    const { tx, tenant } = tenantMock();
    tx.organisation.create.mockResolvedValue({ id: 'o1', name: 'Org', purpose: 'p', registrationNumber: 'RN1' });
    tx.user.create.mockResolvedValue({ id: 'u1', orgId: 'o1', email: 'a@b.test', roleId: 'role_ngo_admin', mustChangePassword: true });

    const repo = new AuthRepository(tenant as never);
    const { org, user } = await repo.createOrganisationAndAdmin({
      organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test', passwordHash: 'h', regionId: 'r1', governorateIds: ['g1'], centerIds: ['c1'],
    });

    expect(org.id).toBe('o1');
    expect(user.roleId).toBe('role_ngo_admin');
    expect(tx.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ roleId: 'role_ngo_admin', mustChangePassword: true }),
    }));
    // consentedAt must NOT be stamped at signup time anymore.
    const firstCall = tx.user.create.mock.calls[0];
    expect(firstCall).toBeDefined();
    const createArgs = firstCall![0];
    expect(createArgs.data.consentedAt).toBeUndefined();
  });

  it('maps a P2002 on registration_number to a 409 ORGANIZATION_ALREADY_REGISTERED', async () => {
    const { tx, tenant } = tenantMock();
    const err = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: ['registration_number'] } });
    tx.organisation.create.mockRejectedValue(err);
    const repo = new AuthRepository(tenant as never);
    await expect(repo.createOrganisationAndAdmin({
      organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test', passwordHash: 'h', regionId: 'r1', governorateIds: ['g1'], centerIds: ['c1'],
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a P2002 to 409 from the pg driver-adapter error shape (no meta.target)', async () => {
    // The pg driver adapter leaves meta.target undefined and nests the raw
    // Postgres message (with the constraint name) instead — the shape actually
    // seen at runtime. uniqueField must still detect the offending column.
    const { tx, tenant } = tenantMock();
    const err = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002', clientVersion: 'x',
      meta: { modelName: 'Organisation', driverAdapterError: { cause: { originalMessage: 'duplicate key value violates unique constraint "organisations_registration_number_key"' } } },
    });
    tx.organisation.create.mockRejectedValue(err);
    const repo = new AuthRepository(tenant as never);
    await expect(repo.createOrganisationAndAdmin({
      organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test', passwordHash: 'h', regionId: 'r1', governorateIds: ['g1'], centerIds: ['c1'],
    })).rejects.toBeInstanceOf(ConflictException);
  });
});
