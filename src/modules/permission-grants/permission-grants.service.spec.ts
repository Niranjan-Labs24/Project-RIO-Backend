import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../tenancy/org-context';
import { PermissionGrantsService } from './permission-grants.service';

const asActor = <T>(fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'admin-1' }, fn);

const grantRow = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  granteeId: 'u1',
  module: 'reportsDashboards',
  action: 'export',
  reason: 'Audit',
  grantedBy: 'admin-1',
  grantedAt: new Date('2026-01-01T00:00:00Z'),
  expiresAt: null as Date | null,
  revokedAt: null as Date | null,
  revokedBy: null as string | null,
  ...over,
});

function setup() {
  const prisma = {
    permissionGrant: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  const tx = { user: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() } };
  const tenant = { runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    prisma,
    tx,
    audit,
    svc: new PermissionGrantsService(prisma as never, tenant as never, audit as never),
  };
}

describe('PermissionGrantsService lookups', () => {
  it('cites an active grant with its expiry, or nothing when there is none', async () => {
    const { svc, prisma } = setup();
    prisma.permissionGrant.findFirst.mockResolvedValueOnce({
      id: 'g1',
      grantedBy: 'admin-1',
      reason: 'Audit',
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    });
    expect(await svc.findActiveGrant('u1', 'm', 'a')).toEqual({
      grantId: 'g1',
      approvedBy: 'admin-1',
      reason: 'Audit',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    prisma.permissionGrant.findFirst.mockResolvedValueOnce({
      id: 'g2',
      grantedBy: 'a',
      reason: 'r',
      expiresAt: null,
    });
    expect((await svc.findActiveGrant('u1', 'm', 'a'))!.expiresAt).toBeNull();
    prisma.permissionGrant.findFirst.mockResolvedValueOnce(null);
    expect(await svc.findActiveGrant('u1', 'm', 'a')).toBeNull();
  });

  it("lists a user's active grants", async () => {
    const { svc, prisma } = setup();
    prisma.permissionGrant.findMany.mockResolvedValue([{ module: 'm', action: 'a' }]);
    expect(await svc.listActiveGrantsForUser('u1')).toEqual([{ module: 'm', action: 'a' }]);
  });

  it('lists every grant with names and an active flag', async () => {
    const { svc, prisma, tx } = setup();
    prisma.permissionGrant.findMany.mockResolvedValue([
      grantRow(),
      grantRow({ id: 'g2', revokedAt: new Date(), revokedBy: 'admin-2' }),
      grantRow({ id: 'g3', expiresAt: new Date('2000-01-01T00:00:00Z') }),
      grantRow({ id: 'g4', expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);
    tx.user.findMany.mockResolvedValue([
      { id: 'u1', name: 'Ana' },
      { id: 'admin-1', name: 'Boss' },
    ]);
    const grants = await svc.list();
    expect(grants.map((g) => g.isActive)).toEqual([true, false, false, true]);
    expect(grants[0]).toMatchObject({
      granteeName: 'Ana',
      grantedByName: 'Boss',
      revokedByName: null,
    });
    expect(grants[1]!.revokedByName).toBeNull(); // admin-2 has no name row
  });
});

describe('PermissionGrantsService create', () => {
  let ctx: ReturnType<typeof setup>;
  const payload = {
    granteeId: 'u1',
    module: 'reportsDashboards',
    action: 'export',
    reason: 'Audit',
  } as never;
  beforeEach(() => {
    ctx = setup();
    ctx.tx.user.findUnique.mockResolvedValue({
      id: 'u1',
      name: 'Ana',
      roleId: 'role_center_supervisor',
    });
    ctx.prisma.permissionGrant.findFirst.mockResolvedValue(null);
    ctx.prisma.permissionGrant.create.mockResolvedValue(grantRow());
  });

  it('issues a grant to a center supervisor and audits it', async () => {
    const grant = await asActor(() => ctx.svc.create(payload));
    expect(grant.id).toBe('g1');
    expect(ctx.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create', organizationId: null }),
    );
    expect(ctx.audit.record.mock.calls[0]![0].changes.at(-1).after).toBe('Never');
  });

  it('records the expiry date when one is given', async () => {
    ctx.prisma.permissionGrant.create.mockResolvedValue(
      grantRow({ expiresAt: new Date('2027-01-01T00:00:00Z') }),
    );
    await asActor(() =>
      ctx.svc.create({ ...(payload as object), expiresAt: '2027-01-01T00:00:00Z' } as never),
    );
    expect(ctx.prisma.permissionGrant.create.mock.calls[0]![0].data.expiresAt).toEqual(
      new Date('2027-01-01T00:00:00Z'),
    );
    expect(ctx.audit.record.mock.calls[0]![0].changes.at(-1).after).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('rejects an invalid expiry date before writing anything', async () => {
    await expect(
      asActor(() => ctx.svc.create({ ...(payload as object), expiresAt: 'soon' } as never)),
    ).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(ctx.prisma.permissionGrant.create).not.toHaveBeenCalled();
  });

  it('refuses an unknown grantee, a non-supervisor, and a duplicate active grant', async () => {
    ctx.tx.user.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => ctx.svc.create(payload))).rejects.toMatchObject({
      response: { error: { code: 'GRANTEE_NOT_FOUND' } },
    });
    ctx.tx.user.findUnique.mockResolvedValueOnce({
      id: 'u1',
      name: 'Ana',
      roleId: 'role_ngo_admin',
    });
    await expect(asActor(() => ctx.svc.create(payload))).rejects.toMatchObject({
      response: { error: { code: 'GRANTEE_NOT_SUPERVISOR' } },
    });
    ctx.prisma.permissionGrant.findFirst.mockResolvedValueOnce({
      id: 'g0',
      grantedBy: 'a',
      reason: 'r',
      expiresAt: null,
    });
    await expect(asActor(() => ctx.svc.create(payload))).rejects.toMatchObject({
      response: { error: { code: 'GRANT_ALREADY_ACTIVE' } },
    });
  });
});

describe('PermissionGrantsService revoke', () => {
  it('revokes an active grant and audits it, naming the grantee when known', async () => {
    const { svc, prisma, tx, audit } = setup();
    prisma.permissionGrant.findUnique.mockResolvedValue(grantRow());
    prisma.permissionGrant.update.mockResolvedValue(
      grantRow({ revokedAt: new Date(), revokedBy: 'admin-1' }),
    );
    tx.user.findUnique.mockResolvedValueOnce({ name: 'Ana' });
    const grant = await asActor(() => svc.revoke('g1'));
    expect(grant.isActive).toBe(false);
    expect(audit.record.mock.calls[0]![0].entityLabel).toContain('Ana');

    tx.user.findUnique.mockResolvedValueOnce(null);
    await asActor(() => svc.revoke('g1'));
    expect(audit.record.mock.calls[1]![0].entityLabel).toContain('u1');
  });

  it('refuses an unknown or already revoked grant', async () => {
    const { svc, prisma } = setup();
    prisma.permissionGrant.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.revoke('x'))).rejects.toMatchObject({
      response: { error: { code: 'GRANT_NOT_FOUND' } },
    });
    prisma.permissionGrant.findUnique.mockResolvedValueOnce(grantRow({ revokedAt: new Date() }));
    await expect(asActor(() => svc.revoke('g1'))).rejects.toMatchObject({
      response: { error: { code: 'GRANT_ALREADY_REVOKED' } },
    });
  });
});
