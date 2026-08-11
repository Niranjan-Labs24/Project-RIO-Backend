import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConsentService } from './consent.service';

/**
 * RIO-DATA-001 — ConsentService is what makes "registration cannot complete
 * without acceptance" enforceable: signup resolves the active policy of each
 * kind through it and validates the submitted version against the result. A
 * silent null here would let an un-consented account through, so the missing
 * -policy case is asserted as loudly as the happy path.
 */

interface PolicyRow {
  kind: 'use_policy' | 'data_sharing';
  version: string;
  text: string;
  active: boolean;
  createdAt: Date;
}

const USE_V1: PolicyRow = {
  kind: 'use_policy',
  version: 'v1',
  text: 'Use policy text',
  active: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};
const SHARING_V1: PolicyRow = {
  kind: 'data_sharing',
  version: 'v1',
  text: 'Data-sharing consent text',
  active: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

/**
 * Stands in for `prisma.consentPolicy`, applying the same `where`/`orderBy`
 * the service passes so the per-kind + active filtering is genuinely
 * exercised rather than assumed.
 */
function fakePrisma(rows: PolicyRow[]) {
  const findFirst = vi.fn(
    async ({
      where,
      orderBy,
    }: {
      where: { kind: string; active: boolean };
      orderBy?: { createdAt: 'asc' | 'desc' };
    }) => {
      const matches = rows.filter((r) => r.kind === where.kind && r.active === where.active);
      matches.sort((a, b) =>
        orderBy?.createdAt === 'desc'
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : a.createdAt.getTime() - b.createdAt.getTime(),
      );
      return matches[0] ?? null;
    },
  );
  return { prisma: { consentPolicy: { findFirst } }, findFirst };
}

function fakeTenant(admin: Record<string, unknown> | null) {
  return {
    runInOrgContext: async (fn: (tx: unknown) => unknown) =>
      fn({ user: { findFirst: async () => admin } }),
  };
}

describe('ConsentService.getActivePolicy (RIO-DATA-001)', () => {
  it('returns the active policy for the requested kind only', async () => {
    const { prisma, findFirst } = fakePrisma([USE_V1, SHARING_V1]);
    const svc = new ConsentService(prisma as never, fakeTenant(null) as never);

    await expect(svc.getActivePolicy('use_policy')).resolves.toEqual({
      kind: 'use_policy',
      version: 'v1',
      text: 'Use policy text',
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { kind: 'use_policy', active: true } }),
    );
  });

  it('does not fall back to the other kind when one is missing', async () => {
    // Only the use policy is configured — asking for the sharing consent must
    // fail rather than silently returning the use policy's text.
    const { prisma } = fakePrisma([USE_V1]);
    const svc = new ConsentService(prisma as never, fakeTenant(null) as never);

    await expect(svc.getActivePolicy('data_sharing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['use_policy' as const, 'use'],
    ['data_sharing' as const, 'data-sharing'],
  ])('throws NO_ACTIVE_CONSENT_POLICY naming the %s kind', async (kind, label) => {
    const { prisma } = fakePrisma([]);
    const svc = new ConsentService(prisma as never, fakeTenant(null) as never);

    await expect(svc.getActivePolicy(kind)).rejects.toMatchObject({
      response: {
        error: {
          code: 'NO_ACTIVE_CONSENT_POLICY',
          message: expect.stringContaining(label),
        },
      },
    });
  });

  it('ignores a deactivated policy even when it is the only row of that kind', async () => {
    const { prisma } = fakePrisma([{ ...USE_V1, active: false }]);
    const svc = new ConsentService(prisma as never, fakeTenant(null) as never);

    await expect(svc.getActivePolicy('use_policy')).rejects.toMatchObject({
      response: { error: { code: 'NO_ACTIVE_CONSENT_POLICY' } },
    });
  });

  it('picks the newest active row when a kind has more than one', async () => {
    // Guards the `orderBy: { createdAt: 'desc' }` — if two rows of a kind are
    // ever active at once, registration must validate against the newer text,
    // not whichever row the database happened to return first.
    const newer: PolicyRow = {
      kind: 'use_policy',
      version: 'v2',
      text: 'Revised use policy text',
      active: true,
      createdAt: new Date('2026-06-01T00:00:00Z'),
    };
    const { prisma } = fakePrisma([USE_V1, newer]);
    const svc = new ConsentService(prisma as never, fakeTenant(null) as never);

    await expect(svc.getActivePolicy('use_policy')).resolves.toMatchObject({
      version: 'v2',
      text: 'Revised use policy text',
    });
  });
});

describe('ConsentService.getActivePolicies (RIO-DATA-001)', () => {
  it('returns both consents in one payload, keyed for the registration form', async () => {
    const { prisma } = fakePrisma([USE_V1, SHARING_V1]);
    const svc = new ConsentService(prisma as never, fakeTenant(null) as never);

    await expect(svc.getActivePolicies()).resolves.toEqual({
      usePolicy: { kind: 'use_policy', version: 'v1', text: 'Use policy text' },
      dataSharing: { kind: 'data_sharing', version: 'v1', text: 'Data-sharing consent text' },
    });
  });

  it('fails the whole call when either kind has no active policy', async () => {
    // The signup screen renders both checkboxes together — a half-populated
    // response would let it show one consent and register without the other.
    const { prisma } = fakePrisma([SHARING_V1]);
    const svc = new ConsentService(prisma as never, fakeTenant(null) as never);

    await expect(svc.getActivePolicies()).rejects.toMatchObject({
      response: { error: { code: 'NO_ACTIVE_CONSENT_POLICY' } },
    });
  });
});

describe('ConsentService.getOrganizationStatus (RIO-DATA-001 AC2)', () => {
  const admin = {
    name: 'Org Admin',
    email: 'admin@demo-ngo.org',
    consentedAt: new Date('2026-08-06T09:30:00Z'),
    consentedPolicyVersion: 'v1',
    sharingConsentedAt: new Date('2026-08-06T09:30:00Z'),
    sharingConsentedPolicyVersion: 'v1',
  };

  it('reports the acceptance date and policy version of each consent', async () => {
    const { prisma } = fakePrisma([USE_V1, SHARING_V1]);
    const svc = new ConsentService(prisma as never, fakeTenant(admin) as never);

    await expect(svc.getOrganizationStatus()).resolves.toEqual({
      usePolicy: { version: 'v1', acceptedAt: '2026-08-06T09:30:00.000Z' },
      dataSharing: { version: 'v1', acceptedAt: '2026-08-06T09:30:00.000Z' },
      acceptedByName: 'Org Admin',
      acceptedByEmail: 'admin@demo-ngo.org',
    });
  });

  it('reports the two consents independently for a pre-split account', async () => {
    // An org that registered before the data-sharing consent existed: the use
    // policy shows as accepted, the sharing consent as outstanding. That is
    // the honest state and the one the post-login consent gate acts on —
    // inferring sharing acceptance from the use policy would fabricate a
    // consent record.
    const { prisma } = fakePrisma([USE_V1, SHARING_V1]);
    const legacyAdmin = { ...admin, sharingConsentedAt: null, sharingConsentedPolicyVersion: null };
    const svc = new ConsentService(prisma as never, fakeTenant(legacyAdmin) as never);

    const status = await svc.getOrganizationStatus();
    expect(status.usePolicy).toEqual({ version: 'v1', acceptedAt: '2026-08-06T09:30:00.000Z' });
    expect(status.dataSharing).toEqual({ version: null, acceptedAt: null });
  });

  it('reports a version only when that consent was actually accepted', async () => {
    // A stale version string with no acceptance timestamp must not read as an
    // acceptance — the date is what proves it happened.
    const { prisma } = fakePrisma([USE_V1, SHARING_V1]);
    const orphaned = { ...admin, consentedAt: null, consentedPolicyVersion: 'v1' };
    const svc = new ConsentService(prisma as never, fakeTenant(orphaned) as never);

    await expect(svc.getOrganizationStatus()).resolves.toMatchObject({
      usePolicy: { version: null, acceptedAt: null },
    });
  });

  it('attributes the acceptance to the NGO Admin, not to whoever onboarded last', async () => {
    const tenant = {
      runInOrgContext: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ user: { findFirst: async (args: { where: unknown }) => (expect(args.where).toEqual({ roleId: 'role_ngo_admin' }), admin) } }),
      ),
    };
    const { prisma } = fakePrisma([USE_V1, SHARING_V1]);
    const svc = new ConsentService(prisma as never, tenant as never);

    await expect(svc.getOrganizationStatus()).resolves.toMatchObject({
      acceptedByName: 'Org Admin',
      acceptedByEmail: 'admin@demo-ngo.org',
    });
    expect(tenant.runInOrgContext).toHaveBeenCalledOnce();
  });

  it('returns all-null fields rather than throwing when the org has no admin row', async () => {
    const { prisma } = fakePrisma([USE_V1, SHARING_V1]);
    const svc = new ConsentService(prisma as never, fakeTenant(null) as never);

    await expect(svc.getOrganizationStatus()).resolves.toEqual({
      usePolicy: { version: null, acceptedAt: null },
      dataSharing: { version: null, acceptedAt: null },
      acceptedByName: null,
      acceptedByEmail: null,
    });
  });
});
