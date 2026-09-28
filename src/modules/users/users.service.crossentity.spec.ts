import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma';
import { orgContext, type OrgStore } from '../../tenancy/org-context';
import { UsersService } from './users.service';

const run = <T>(store: Partial<OrgStore>, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'admin-1', ...store } as OrgStore, fn);
const asAdmin = <T>(fn: () => Promise<T>) => run({ role: 'system_admin' }, fn);
const asNgo = <T>(fn: () => Promise<T>) => run({ role: 'ngo_admin' }, fn);

const user = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  orgId: 'org-1',
  name: 'Ana',
  email: 'ana@x.test',
  mobileNumber: null,
  roleId: 'role_ngo_research_officer',
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

function setup() {
  const tx = {
    user: {
      findMany: vi.fn().mockResolvedValue([user()]),
      findUnique: vi.fn().mockResolvedValue(user()),
      create: vi
        .fn()
        .mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
          user({ id: 'new', ...data }),
        ),
      update: vi
        .fn()
        .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => user(data)),
      delete: vi.fn(),
    },
    organisation: {
      findUnique: vi.fn().mockResolvedValue({ id: 'org-1', name: 'Acme', isActive: true }),
    },
  };
  const tenant = {
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsOrg: async (_o: string, fn: (t: unknown) => unknown) => fn(tx),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const passwords = { hash: vi.fn().mockResolvedValue('hash') };
  const mailer = { sendTemporaryPassword: vi.fn().mockResolvedValue(true) };
  return {
    tx,
    audit,
    mailer,
    svc: new UsersService(tenant as never, audit as never, passwords as never, mailer as never),
  };
}

describe('UsersService organization users (cross-entity)', () => {
  it('lists the users of an organization and audits the view', async () => {
    const { svc, audit } = setup();
    const users = await asAdmin(() => svc.listForOrg('org-1', { limit: 5, offset: 1 }));
    expect(users).toHaveLength(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SYSTEM_ADMIN_VIEWED_ORGANIZATION_USERS' }),
    );
  });

  it('refuses every cross-entity action for other roles', async () => {
    const { svc } = setup();
    for (const call of [
      () => svc.listForOrg('org-1'),
      () => svc.getNgoAdminsForOrg('org-1'),
      () => svc.assignNgoAdmin('org-1', {} as never),
      () =>
        svc.updateUserRoleForOrg('org-1', 'u1', { roleId: 'role_ngo_research_officer' } as never),
      () => svc.updateUserStatusForOrg('org-1', 'u1', { status: 'disabled' } as never),
      () => svc.resendInviteForOrg('org-1', 'u1'),
      () => svc.createForOrg({ roleId: 'role_ngo_research_officer' } as never),
    ] as Array<() => Promise<unknown>>) {
      await expect(asNgo(call)).rejects.toMatchObject({
        response: { error: { code: 'FORBIDDEN' } },
      });
    }
    await expect(run({}, () => svc.listForOrg('org-1'))).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
  });

  it('lists the NGO admins of an organization', async () => {
    const { svc, tx } = setup();
    tx.user.findMany.mockResolvedValue([user({ roleId: 'role_ngo_admin' })]);
    expect((await asAdmin(() => svc.getNgoAdminsForOrg('org-1')))[0]!.role.key).toBe('ngo_admin');
  });
});

describe('UsersService.assignNgoAdmin', () => {
  it('promotes an existing user, bumping their session, and audits it', async () => {
    const { svc, tx, audit } = setup();
    const result = await asAdmin(() =>
      svc.assignNgoAdmin('org-1', { userId: 'u1', reason: 'Handover' } as never),
    );
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { roleId: 'role_ngo_admin', sessionVersion: { increment: 1 } },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'NGO_ADMIN_ASSIGNED' }),
    );
    expect(result.temporaryPasswordEmailed).toBe(false);
  });

  it('replaces the previous NGO admin, who falls back to research officer', async () => {
    const { svc, tx, audit } = setup();
    tx.user.findMany.mockResolvedValue([user({ id: 'old', roleId: 'role_ngo_admin' })]);
    await asAdmin(() => svc.assignNgoAdmin('org-1', { userId: 'u1', reason: 'r' } as never));
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'old' },
      data: { roleId: 'role_ngo_research_officer', sessionVersion: { increment: 1 } },
    });
    expect(audit.record.mock.calls.map((c) => c[0].action)).toContain('NGO_ADMIN_CHANGED');
  });

  it('does not change the role of a user who already is an NGO admin', async () => {
    const { svc, tx } = setup();
    tx.user.findUnique.mockResolvedValue(user({ roleId: 'role_ngo_admin' }));
    tx.user.findMany.mockResolvedValue([]);
    await asAdmin(() => svc.assignNgoAdmin('org-1', { userId: 'u1' } as never));
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('invites a new NGO admin with a temporary password when a name and email are given', async () => {
    const { svc, mailer, audit } = setup();
    const result = await asAdmin(() =>
      svc.assignNgoAdmin('org-1', { name: 'New', email: 'new@x.test', reason: 'r' } as never),
    );
    expect(result.temporaryPasswordEmailed).toBe(true);
    expect(mailer.sendTemporaryPassword).toHaveBeenCalled();
    expect(audit.record.mock.calls.map((c) => c[0].action)).toContain(
      'USER_INVITED_BY_SYSTEM_ADMIN',
    );
  });

  it('refuses an unknown or inactive organization, a user elsewhere, and an incomplete request', async () => {
    const { svc, tx } = setup();
    tx.organisation.findUnique.mockResolvedValueOnce(null);
    await expect(
      asAdmin(() => svc.assignNgoAdmin('x', { userId: 'u1' } as never)),
    ).rejects.toMatchObject({ response: { error: { code: 'ORG_NOT_FOUND' } } });
    tx.organisation.findUnique.mockResolvedValueOnce({ id: 'org-1', name: 'A', isActive: false });
    await expect(
      asAdmin(() => svc.assignNgoAdmin('org-1', { userId: 'u1' } as never)),
    ).rejects.toMatchObject({ response: { error: { code: 'INACTIVE_ORG' } } });
    tx.user.findUnique.mockResolvedValueOnce(user({ orgId: 'other' }));
    await expect(
      asAdmin(() => svc.assignNgoAdmin('org-1', { userId: 'u1' } as never)),
    ).rejects.toMatchObject({ response: { error: { code: 'USER_NOT_FOUND' } } });
    tx.user.findUnique.mockResolvedValueOnce(null);
    await expect(
      asAdmin(() => svc.assignNgoAdmin('org-1', { userId: 'u1' } as never)),
    ).rejects.toMatchObject({ response: { error: { code: 'USER_NOT_FOUND' } } });
    await expect(asAdmin(() => svc.assignNgoAdmin('org-1', {} as never))).rejects.toMatchObject({
      response: { error: { code: 'INVALID_ASSIGNMENT_PAYLOAD' } },
    });
  });
});

describe('UsersService.updateUserRoleForOrg', () => {
  it('routes an NGO admin role to the assignment flow', async () => {
    const { svc, audit } = setup();
    await asAdmin(() =>
      svc.updateUserRoleForOrg('org-1', 'u1', { roleId: 'role_ngo_admin' } as never),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'NGO_ADMIN_ASSIGNED' }),
    );
  });

  it('changes another role and audits it differently when the user was an NGO admin', async () => {
    const { svc, tx, audit } = setup();
    await asAdmin(() =>
      svc.updateUserRoleForOrg('org-1', 'u1', {
        roleId: 'role_data_analyst',
        reason: 'Move',
      } as never),
    );
    expect(audit.record.mock.calls[0]![0]).toMatchObject({
      action: 'USER_ROLE_CHANGED_BY_SYSTEM_ADMIN',
      metadata: { reason: 'Move' },
    });
    await asAdmin(() =>
      svc.updateUserRoleForOrg('org-1', 'u1', { roleId: 'role_data_analyst' } as never),
    );
    expect(audit.record.mock.calls[1]![0].metadata).toBeUndefined();
    tx.user.findUnique.mockResolvedValue(user({ roleId: 'role_ngo_admin' }));
    await asAdmin(() =>
      svc.updateUserRoleForOrg('org-1', 'u1', { roleId: 'role_data_analyst' } as never),
    );
    expect(audit.record.mock.calls[2]![0].action).toBe('NGO_ADMIN_ROLE_REMOVED');
  });

  it('refuses an unknown user, and a role that cannot be assigned', async () => {
    const { svc, tx } = setup();
    tx.user.findUnique.mockResolvedValueOnce(null);
    await expect(
      asAdmin(() =>
        svc.updateUserRoleForOrg('org-1', 'x', { roleId: 'role_data_analyst' } as never),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'USER_NOT_FOUND' } } });
    await expect(
      asAdmin(() =>
        svc.updateUserRoleForOrg('org-1', 'u1', { roleId: 'role_system_admin' } as never),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'INVALID_ROLE' } } });
    await expect(
      asAdmin(() => svc.updateUserRoleForOrg('org-1', 'u1', { roleId: 'nope' } as never)),
    ).rejects.toMatchObject({ response: { error: { code: 'INVALID_ROLE' } } });
  });
});

describe('UsersService.updateUserStatusForOrg', () => {
  it('disables and re-enables a user and audits each with the reason', async () => {
    const { svc, audit } = setup();
    await asAdmin(() =>
      svc.updateUserStatusForOrg('org-1', 'u1', { status: 'disabled', reason: 'Left' } as never),
    );
    expect(audit.record.mock.calls[0]![0]).toMatchObject({
      action: 'USER_DISABLED_BY_SYSTEM_ADMIN',
      metadata: { reason: 'Left' },
    });
    const { svc: s2, tx, audit: a2 } = setup();
    tx.user.findUnique.mockResolvedValue(user({ status: 'disabled' }));
    await asAdmin(() => s2.updateUserStatusForOrg('org-1', 'u1', { status: 'active' } as never));
    expect(a2.record.mock.calls[0]![0]).toMatchObject({
      action: 'USER_ENABLED_BY_SYSTEM_ADMIN',
      metadata: undefined,
    });
  });

  it('does nothing when the status is already that', async () => {
    const { svc, tx } = setup();
    await asAdmin(() => svc.updateUserStatusForOrg('org-1', 'u1', { status: 'active' } as never));
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('refuses disabling yourself, an unknown organization or user, and enabling in an inactive organization', async () => {
    const { svc, tx } = setup();
    await expect(
      asAdmin(() =>
        svc.updateUserStatusForOrg('org-1', 'admin-1', { status: 'disabled' } as never),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'CANNOT_DISABLE_SELF' } } });
    tx.organisation.findUnique.mockResolvedValueOnce(null);
    await expect(
      asAdmin(() => svc.updateUserStatusForOrg('x', 'u1', { status: 'disabled' } as never)),
    ).rejects.toMatchObject({ response: { error: { code: 'ORG_NOT_FOUND' } } });
    tx.organisation.findUnique.mockResolvedValueOnce({ id: 'org-1', name: 'A', isActive: false });
    await expect(
      asAdmin(() => svc.updateUserStatusForOrg('org-1', 'u1', { status: 'active' } as never)),
    ).rejects.toMatchObject({ response: { error: { code: 'INACTIVE_ORG' } } });
    tx.user.findUnique.mockResolvedValueOnce(user({ orgId: 'other' }));
    await expect(
      asAdmin(() => svc.updateUserStatusForOrg('org-1', 'u1', { status: 'disabled' } as never)),
    ).rejects.toMatchObject({ response: { error: { code: 'USER_NOT_FOUND' } } });
  });
});

describe('UsersService.resendInviteForOrg and createForOrg', () => {
  it('resends an invitation to a user still invited', async () => {
    const { svc, tx, audit, mailer } = setup();
    tx.user.findUnique.mockResolvedValue(user({ status: 'invited' }));
    const result = await asAdmin(() => svc.resendInviteForOrg('org-1', 'u1'));
    expect(result.temporaryPasswordEmailed).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'USER_INVITATION_RESENT' }),
    );
    expect(mailer.sendTemporaryPassword).toHaveBeenCalled();
  });

  it('refuses an inactive organization, an unknown user, and one who already signed in', async () => {
    const { svc, tx } = setup();
    tx.organisation.findUnique.mockResolvedValueOnce(null);
    await expect(asAdmin(() => svc.resendInviteForOrg('org-1', 'u1'))).rejects.toMatchObject({
      response: { error: { code: 'INACTIVE_ORG' } },
    });
    tx.user.findUnique.mockResolvedValueOnce(null);
    await expect(asAdmin(() => svc.resendInviteForOrg('org-1', 'u1'))).rejects.toMatchObject({
      response: { error: { code: 'USER_NOT_FOUND' } },
    });
    await expect(asAdmin(() => svc.resendInviteForOrg('org-1', 'u1'))).rejects.toMatchObject({
      response: { error: { code: 'USER_NOT_INVITED' } },
    });
  });

  it('creates a user in an organization, normalising the mobile number', async () => {
    const { svc, tx, audit } = setup();
    await asAdmin(() =>
      svc.createForOrg({
        organizationId: 'org-1',
        name: 'New',
        email: 'n@x.test',
        roleId: 'role_ngo_research_officer',
        mobileNumber: '+966 (51) 234-5678',
      } as never),
    );
    expect(tx.user.create.mock.calls[0]![0].data.mobileNumber).toBe('+966512345678');
    expect(
      audit.record.mock.calls[0]![0].changes.some(
        (c: { field: string }) => c.field === 'Mobile number',
      ),
    ).toBe(true);
    tx.organisation.findUnique.mockResolvedValueOnce(null);
    await asAdmin(() =>
      svc.createForOrg({
        organizationId: 'org-1',
        name: 'N',
        email: 'n2@x.test',
        roleId: 'role_ngo_research_officer',
      } as never),
    );
    expect(tx.user.create.mock.calls[1]![0].data.mobileNumber).toBeNull();
  });

  it('turns a duplicate email into a conflict and rethrows other errors', async () => {
    const { svc, tx } = setup();
    tx.user.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(
      asAdmin(() =>
        svc.createForOrg({
          organizationId: 'org-1',
          name: 'N',
          email: 'a@x.test',
          roleId: 'role_ngo_research_officer',
        } as never),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'EMAIL_TAKEN' } } });
    tx.user.create.mockRejectedValueOnce(new Error('db'));
    await expect(
      asAdmin(() =>
        svc.createForOrg({
          organizationId: 'org-1',
          name: 'N',
          email: 'b@x.test',
          roleId: 'role_ngo_research_officer',
        } as never),
      ),
    ).rejects.toThrow('db');
  });

  it('only lets a cross-entity caller assign a cross-entity role', async () => {
    const { svc } = setup();
    await expect(
      asNgo(() =>
        svc.invite({ name: 'X', email: 'x@x.test', roleId: 'role_center_supervisor' } as never),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'FORBIDDEN_ROLE_ASSIGNMENT' } } });
    await expect(
      run({}, () =>
        svc.invite({ name: 'X', email: 'x@x.test', roleId: 'role_center_supervisor' } as never),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'FORBIDDEN_ROLE_ASSIGNMENT' } } });
  });
});

describe('UsersService organization scope', () => {
  it('invites with a mobile number and an organization with no name', async () => {
    const { svc, tx } = setup();
    tx.organisation.findUnique.mockResolvedValue(null);
    await asNgo(() =>
      svc.invite({
        name: 'X',
        email: 'x@x.test',
        roleId: 'role_ngo_research_officer',
        mobileNumber: ' 055 123 ',
      } as never),
    );
    expect(tx.user.create.mock.calls[0]![0].data.mobileNumber).toBe('055123');
  });

  it('updates a user, only auditing real changes and bumping the session on a role or status change', async () => {
    const { svc, tx, audit } = setup();
    await asNgo(() => svc.update('u1', { name: 'Ana', mobileNumber: '  ' } as never));
    expect(tx.user.update.mock.calls[0]![0].data).toEqual({ name: 'Ana', mobileNumber: '' });
    expect(audit.record).toHaveBeenCalledTimes(1);
    await asNgo(() =>
      svc.update('u1', {
        name: 'Changed',
        status: 'disabled',
        roleId: 'role_data_analyst',
        mobileNumber: '+9665',
      } as never),
    );
    expect(tx.user.update.mock.calls[1]![0].data.sessionVersion).toEqual({ increment: 1 });
    tx.user.findUnique.mockResolvedValueOnce(null);
    await expect(asNgo(() => svc.update('x', {} as never))).rejects.toMatchObject({
      response: { error: { code: 'USER_NOT_FOUND' } },
    });
  });

  it('removes a user, but not yourself, an unknown user, or a cross-entity account as a plain admin', async () => {
    const { svc, tx, audit } = setup();
    await asNgo(() => svc.remove('u1'));
    expect(tx.user.delete).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete' }));
    await expect(asNgo(() => svc.remove('admin-1'))).rejects.toMatchObject({
      response: { error: { code: 'CANNOT_REMOVE_SELF' } },
    });
    tx.user.findUnique.mockResolvedValueOnce(null);
    await expect(asNgo(() => svc.remove('x'))).rejects.toMatchObject({
      response: { error: { code: 'USER_NOT_FOUND' } },
    });
    tx.user.findUnique.mockResolvedValueOnce(user({ roleId: 'role_center_supervisor' }));
    await expect(asNgo(() => svc.remove('u9'))).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN_USER_REMOVAL' } },
    });
    tx.user.findUnique.mockResolvedValueOnce(user({ roleId: 'role_center_supervisor' }));
    await asAdmin(() => svc.remove('u9'));
  });

  it('shows an unrecognised role as unknown, and pages the list', async () => {
    const { svc, tx } = setup();
    tx.user.findMany.mockResolvedValue([user({ roleId: 'role_gone' })]);
    expect((await asNgo(() => svc.list({ limit: 999, offset: -2 })))[0]!.role.key).toBe('unknown');
    expect(tx.user.findMany.mock.calls[0]![0]).toMatchObject({ take: 200, skip: 0 });
  });
});
