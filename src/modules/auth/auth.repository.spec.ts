import { vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { AuthRepository } from './auth.repository';
import { Prisma } from '../../generated/prisma';

// RIO-DATA-001 — the two consents a registration accepts. AuthService has
// already validated these against the active policy of each kind by the time
// the repository sees them.
const CONSENTS = [
  { kind: 'use_policy' as const, version: 'v1', text: 'use policy text' },
  { kind: 'data_sharing' as const, version: 'v3', text: 'sharing consent text' },
];

/** The signup input, minus whatever a given test wants to vary. */
const BASE_INPUT = {
  organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test',
  passwordHash: 'h', regionId: 'r1', governorateIds: ['g1'], centerIds: ['c1'],
  consents: CONSENTS,
};

function tenantMock() {
  const tx = {
    organisation: { create: vi.fn(), findFirst: vi.fn() },
    user: { create: vi.fn(), findUnique: vi.fn() },
    consentAcceptance: { createMany: vi.fn() },
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
  // RIO-DATA-001 — consent is captured AS PART OF registration, in this same
  // transaction. This inverts the previous behaviour, where signup left
  // consentedAt null and a post-login gate collected it afterwards.
  it('creates org + ngo_admin and stamps both consents on the admin row', async () => {
    const { tx, tenant } = tenantMock();
    tx.organisation.create.mockResolvedValue({ id: 'o1', name: 'Org', purpose: 'p', registrationNumber: 'RN1' });
    tx.user.create.mockResolvedValue({ id: 'u1', orgId: 'o1', email: 'a@b.test', roleId: 'role_ngo_admin', mustChangePassword: true });

    const repo = new AuthRepository(tenant as never);
    const { org, user } = await repo.createOrganisationAndAdmin(BASE_INPUT);

    expect(org.id).toBe('o1');
    expect(user.roleId).toBe('role_ngo_admin');

    const createArgs = tx.user.create.mock.calls[0]?.[0];
    expect(createArgs).toBeDefined();
    expect(createArgs.data).toMatchObject({ roleId: 'role_ngo_admin', mustChangePassword: true });
    // Each consent lands in its own pair of columns, at the version that was
    // actually accepted — the two versions differ here precisely so a bug
    // that copied one into both would fail this assertion.
    expect(createArgs.data.consentedAt).toBeInstanceOf(Date);
    expect(createArgs.data.consentedPolicyVersion).toBe('v1');
    expect(createArgs.data.sharingConsentedAt).toBeInstanceOf(Date);
    expect(createArgs.data.sharingConsentedPolicyVersion).toBe('v3');
  });

  it('writes one immutable acceptance snapshot per consent kind, in the same transaction', async () => {
    const { tx, tenant } = tenantMock();
    tx.organisation.create.mockResolvedValue({ id: 'o1', name: 'Org', purpose: 'p', registrationNumber: 'RN1' });
    tx.user.create.mockResolvedValue({ id: 'u1', orgId: 'o1', email: 'a@b.test', roleId: 'role_ngo_admin', mustChangePassword: true });

    const repo = new AuthRepository(tenant as never);
    await repo.createOrganisationAndAdmin(BASE_INPUT);

    const rows = tx.consentAcceptance.createMany.mock.calls[0]?.[0]?.data;
    expect(rows).toHaveLength(2);
    // The policy TEXT is snapshotted, not just the version — the acceptance
    // record has to survive the policy text later being edited.
    expect(rows).toContainEqual(expect.objectContaining({
      userId: 'u1', kind: 'use_policy', policyVersion: 'v1', policyText: 'use policy text',
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      userId: 'u1', kind: 'data_sharing', policyVersion: 'v3', policyText: 'sharing consent text',
    }));
    // orgId is the id the repository generated for this registration (it
    // creates the uuid itself rather than reading it back), and it must be
    // the SAME one on both rows and on the org it just created — an
    // acceptance filed against another org's id would be invisible under RLS.
    const orgId = tx.organisation.create.mock.calls[0]?.[0]?.data?.id;
    expect(orgId).toBeTruthy();
    expect(rows.every((r: { orgId: string }) => r.orgId === orgId)).toBe(true);
  });

  it('maps a P2002 on registration_number to a 409 ORGANIZATION_ALREADY_REGISTERED', async () => {
    const { tx, tenant } = tenantMock();
    const err = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: ['registration_number'] } });
    tx.organisation.create.mockRejectedValue(err);
    const repo = new AuthRepository(tenant as never);
    await expect(repo.createOrganisationAndAdmin({
      ...BASE_INPUT,
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
      ...BASE_INPUT,
    })).rejects.toBeInstanceOf(ConflictException);
  });
});
