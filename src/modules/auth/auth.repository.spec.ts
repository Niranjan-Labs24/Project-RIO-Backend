import { vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { AuthRepository } from './auth.repository';
import { Prisma } from '../../generated/prisma';

function tenantMock() {
  const tx = {
    organisation: { create: vi.fn(), findFirst: vi.fn() },
    user: { create: vi.fn(), findUnique: vi.fn() },
    consentPolicy: { findFirst: vi.fn() },
    consentAcceptance: { create: vi.fn() },
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
  it('creates org + ngo_admin + consent acceptance and returns both rows', async () => {
    const { tx, tenant } = tenantMock();
    tx.organisation.create.mockResolvedValue({ id: 'o1', name: 'Org', purpose: 'p', registrationNumber: 'RN1' });
    tx.user.create.mockResolvedValue({ id: 'u1', orgId: 'o1', email: 'a@b.test', roleId: 'role_ngo_admin', mustChangePassword: true });
    tx.consentPolicy.findFirst.mockResolvedValue({ version: 'v1', text: 'policy' });
    tx.consentAcceptance.create.mockResolvedValue({});

    const repo = new AuthRepository(tenant as never);
    const now = new Date();
    const { org, user } = await repo.createOrganisationAndAdmin({
      organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test', passwordHash: 'h', now,
    });

    expect(org.id).toBe('o1');
    expect(user.roleId).toBe('role_ngo_admin');
    expect(tx.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ roleId: 'role_ngo_admin', mustChangePassword: true, consentedAt: now }),
    }));
    expect(tx.consentAcceptance.create).toHaveBeenCalledTimes(1);
  });

  it('maps a P2002 on registration_number to a 409 ORGANIZATION_ALREADY_REGISTERED', async () => {
    const { tx, tenant } = tenantMock();
    const err = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: ['registration_number'] } });
    tx.organisation.create.mockRejectedValue(err);
    const repo = new AuthRepository(tenant as never);
    await expect(repo.createOrganisationAndAdmin({
      organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test', passwordHash: 'h', now: new Date(),
    })).rejects.toBeInstanceOf(ConflictException);
  });
});
