import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { orgContext } from '../../tenancy/org-context';
import { UsersService } from './users.service';
import type { UserRow } from './users.types';

function fakeTenant(opts: { rows?: UserRow[]; current?: UserRow | null; onDelete?: (where: unknown) => void }) {
  const tx = {
    organisation: {
      findUnique: async () => ({ name: 'Test Org' }),
    },
    user: {
      findMany: async () => opts.rows ?? [],
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', createdAt: new Date('2026-01-01T00:00:00Z'), ...data }),
      findUnique: async () => opts.current ?? null,
      update: async ({ data }: { data: Record<string, unknown> }) => ({ ...(opts.current as object), ...data }),
      delete: async ({ where }: { where: unknown }) => { opts.onDelete?.(where); return opts.current; },
    },
  };
  return {
    runInOrgContext: async (fn: (tx: unknown) => unknown) => fn(tx),
    runAsOrg: async (_orgId: string, fn: (tx: unknown) => unknown) => fn(tx),
  };
}

const auditStub = { record: async () => {} };
// A temporary-password stub pair, shared by every test below: hashing is a
// no-op, and the mailer reports "not configured" (matching local dev with no
// SMTP set up) — provisionTemporaryPassword now always reports `emailed:
// true` regardless of this result (see its own comment for why), so this
// stub's return value doesn't change any test's expected outcome.
const passwordsStub = { hash: async () => 'hashed-password' };
const mailerStub = { sendTemporaryPassword: async () => false };

function makeService(tenant: ReturnType<typeof fakeTenant>, audit: unknown = auditStub) {
  return new UsersService(
    tenant as never,
    audit as never,
    passwordsStub as never,
    mailerStub as never,
  );
}

describe('UsersService', () => {
  it('list maps rows to OrgUser with role summary and status', async () => {
    const rows: UserRow[] = [
      { id: 'u1', orgId: 'o1', name: 'A', email: 'a@x.org', roleId: 'role_ngo_admin', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') },
    ];
    const svc = makeService(fakeTenant({ rows }));
    const users = await orgContext.run({ requestId: 'r', orgId: 'o1' }, () => svc.list());
    const firstUser = users[0];
    expect(firstUser).toBeDefined();
    expect(firstUser?.role.key).toBe('ngo_admin');
    expect(firstUser?.status).toBe('active');
  });

  it('invite rejects an invalid roleId', async () => {
    const svc = makeService(fakeTenant({}));
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1' }, () => svc.invite({ name: 'X', email: 'x@x.org', roleId: 'role_bogus' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('invite creates an invited user, provisions a temporary password, and records an audit event', async () => {
    const recorded: unknown[] = [];
    const audit = { record: async (i: unknown) => { recorded.push(i); } };
    const svc = makeService(fakeTenant({}), audit);
    const u = await orgContext.run({ requestId: 'r', orgId: 'o1' }, () =>
      svc.invite({ name: 'New', email: 'n@x.org', roleId: 'role_field_researcher' }),
    );
    expect(u.status).toBe('invited');
    expect(u.role.key).toBe('field_researcher');
    expect(recorded).toHaveLength(1);
    // TEMPORARY (see DEFAULT_TEMP_PASSWORD's comment): every account starts
    // with the same fixed password and the response always claims
    // `emailed: true`, regardless of the mailer stub's actual result —
    // the raw password is never returned to the caller anymore.
    expect(u.temporaryPasswordEmailed).toBe(true);
    expect(u.temporaryPassword).toBeUndefined();
  });

  it('forbids a tenant admin (non-crossEntity) from assigning a crossEntity role (privilege escalation)', async () => {
    const svc = makeService(fakeTenant({}));
    // ngo_admin trying to mint a system_admin (crossEntity) must be blocked.
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1', role: 'ngo_admin' }, () =>
        svc.invite({ name: 'X', email: 'x@x.org', roleId: 'role_system_admin' })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const current: UserRow = { id: 'u1', orgId: 'o1', name: 'Me', email: 'me@x.org', roleId: 'role_ngo_admin', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') };
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1', role: 'ngo_admin' }, () =>
        makeService(fakeTenant({ current })).update('u1', { roleId: 'role_center_supervisor' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a crossEntity admin (system_admin) to assign a crossEntity role', async () => {
    const svc = makeService(fakeTenant({}));
    const u = await orgContext.run({ requestId: 'r', orgId: 'o1', role: 'system_admin' }, () =>
      svc.invite({ name: 'Sup', email: 'sup@x.org', roleId: 'role_center_supervisor' }));
    expect(u.role.key).toBe('center_supervisor');
  });

  it('update computes changes and records an edit', async () => {
    const current: UserRow = { id: 'u1', orgId: 'o1', name: 'Old', email: 'o@x.org', roleId: 'role_field_researcher', status: 'invited', createdAt: new Date('2026-01-01T00:00:00Z') };
    const recorded: { changes?: { field: string; before: unknown; after: unknown }[] }[] = [];
    const audit = { record: async (i: unknown) => { recorded.push(i as never); } };
    const svc = makeService(fakeTenant({ current }), audit);
    const u = await orgContext.run({ requestId: 'r', orgId: 'o1' }, () => svc.update('u1', { status: 'active' }));
    expect(u.status).toBe('active');
    const firstRecorded = recorded[0];
    expect(firstRecorded).toBeDefined();
    expect(firstRecorded?.changes?.[0]).toMatchObject({ field: 'status', before: 'invited', after: 'active' });
  });

  it('remove rejects deleting your own account', async () => {
    const svc = makeService(fakeTenant({}));
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'me', role: 'ngo_admin' }, () => svc.remove('me')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('remove 404s when the target is absent (also the cross-org RLS case)', async () => {
    // In org context, a user in another org is invisible to findUnique, so
    // both "does not exist" and "exists in another org" surface as NOT_FOUND.
    const svc = makeService(fakeTenant({ current: null }));
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'me', role: 'ngo_admin' }, () => svc.remove('someone-else')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('forbids a non-crossEntity admin from removing a crossEntity (system) account', async () => {
    const current: UserRow = { id: 'sys', orgId: 'o1', name: 'System Admin', email: 'sys@x.org', roleId: 'role_system_admin', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') };
    let deleted = false;
    const svc = makeService(fakeTenant({ current, onDelete: () => { deleted = true; } }));
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'me', role: 'ngo_admin' }, () => svc.remove('sys')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deleted).toBe(false); // never reached the delete
  });

  it('removes a regular user and records a delete audit event', async () => {
    const current: UserRow = { id: 'u9', orgId: 'o1', name: 'Field', email: 'field@x.org', roleId: 'role_field_researcher', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') };
    const recorded: { action?: string; entityId?: string; entityLabel?: string }[] = [];
    const audit = { record: async (i: unknown) => { recorded.push(i as never); } };
    let deletedWhere: unknown;
    const svc = makeService(fakeTenant({ current, onDelete: (w) => { deletedWhere = w; } }), audit);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'me', role: 'ngo_admin' }, () => svc.remove('u9'));
    expect(deletedWhere).toEqual({ id: 'u9' });
    expect(recorded[0]).toMatchObject({ action: 'delete', entityId: 'u9', entityLabel: 'field@x.org' });
  });

  it('lets a crossEntity admin (system_admin) remove a crossEntity account', async () => {
    const current: UserRow = { id: 'sys2', orgId: 'o1', name: 'Other System', email: 'sys2@x.org', roleId: 'role_system_admin', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') };
    let deleted = false;
    const svc = makeService(fakeTenant({ current, onDelete: () => { deleted = true; } }));
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'me', role: 'system_admin' }, () => svc.remove('sys2'));
    expect(deleted).toBe(true);
  });

  it('assignNgoAdmin promotes target user and demotes previous admin', async () => {
    const recorded: { action?: string }[] = [];
    const audit = { record: async (i: unknown) => { recorded.push(i as never); } };
    let currentAdmin = { id: 'u1', orgId: 'o1', name: 'Admin', email: 'admin@x.org', roleId: 'role_ngo_admin', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') };
    let targetUser = { id: 'u2', orgId: 'o1', name: 'User2', email: 'u2@x.org', roleId: 'role_ngo_research_officer', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') };

    const fake = {
      runAsOrg: async (_orgId: string, fn: (tx: unknown) => unknown) =>
        fn({
          organisation: {
            findUnique: async () => ({ id: 'o1', name: 'Test Org', isActive: true }),
          },
          user: {
            findUnique: async ({ where }: { where: { id: string } }) => {
              if (where.id === 'u1') return currentAdmin;
              if (where.id === 'u2') return targetUser;
              return null;
            },
            findMany: async ({ where }: { where: { roleId?: string } }) => {
              if (where?.roleId === 'role_ngo_admin') return [currentAdmin];
              return [];
            },
            update: async ({ where, data }: { where: { id: string }; data: { roleId: string } }) => {
              if (where.id === 'u1') { currentAdmin = { ...currentAdmin, roleId: data.roleId }; return currentAdmin; }
              if (where.id === 'u2') { targetUser = { ...targetUser, roleId: data.roleId }; return targetUser; }
              return null;
            },
          },
        }),
      runAsSupervisor: async (fn: (tx: unknown) => unknown) =>
        fn({
          organisation: {
            findUnique: async () => ({ id: 'o1', name: 'Test Org', isActive: true }),
          },
          user: {
            findUnique: async ({ where }: { where: { id: string } }) => {
              if (where.id === 'u1') return currentAdmin;
              if (where.id === 'u2') return targetUser;
              return null;
            },
            findMany: async ({ where }: { where: { roleId?: string } }) => {
              if (where?.roleId === 'role_ngo_admin') return [currentAdmin];
              return [];
            },
            update: async ({ where, data }: { where: { id: string }; data: { roleId: string } }) => {
              if (where.id === 'u1') { currentAdmin = { ...currentAdmin, roleId: data.roleId }; return currentAdmin; }
              if (where.id === 'u2') { targetUser = { ...targetUser, roleId: data.roleId }; return targetUser; }
              return null;
            },
          },
        }),
    };

    const svc = new UsersService(fake as never, audit as never, passwordsStub as never, mailerStub as never);
    const res = await orgContext.run({ requestId: 'r', orgId: 'o1', role: 'system_admin' }, () =>
      svc.assignNgoAdmin('o1', { userId: 'u2', reason: 'Reassignment' }),
    );

    expect(res.role.key).toBe('ngo_admin');
    expect(currentAdmin.roleId).toBe('role_ngo_research_officer');
    expect(recorded.some((a) => a.action === 'NGO_ADMIN_ASSIGNED')).toBe(true);
    expect(recorded.some((a) => a.action === 'NGO_ADMIN_CHANGED')).toBe(true);
  });

  it('assignNgoAdmin rejects assignment for an inactive organization', async () => {
    const fake = {
      runAsOrg: async (_orgId: string, fn: (tx: unknown) => unknown) =>
        fn({
          organisation: {
            findUnique: async () => ({ id: 'o1', name: 'Test Org', isActive: false }),
          },
        }),
      runAsSupervisor: async (fn: (tx: unknown) => unknown) =>
        fn({
          organisation: {
            findUnique: async () => ({ id: 'o1', name: 'Test Org', isActive: false }),
          },
        }),
    };
    const svc = new UsersService(fake as never, auditStub as never, passwordsStub as never, mailerStub as never);
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1', role: 'system_admin' }, () =>
        svc.assignNgoAdmin('o1', { userId: 'u2' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateUserStatusForOrg disables and enables user and logs audit events', async () => {
    const recorded: { action?: string }[] = [];
    const audit = { record: async (i: unknown) => { recorded.push(i as never); } };
    let userRow = { id: 'u3', orgId: 'o1', name: 'Target', email: 't@x.org', roleId: 'role_ngo_research_officer', status: 'active' as 'active' | 'invited' | 'disabled', createdAt: new Date('2026-01-01T00:00:00Z') };

    const fake = {
      runAsOrg: async (_orgId: string, fn: (tx: unknown) => unknown) =>
        fn({
          organisation: {
            findUnique: async () => ({ id: 'o1', name: 'Test Org', isActive: true }),
          },
          user: {
            findUnique: async () => userRow,
            update: async ({ data }: { data: { status: 'active' | 'disabled' } }) => {
              userRow = { ...userRow, status: data.status };
              return userRow;
            },
          },
        }),
      runAsSupervisor: async (fn: (tx: unknown) => unknown) =>
        fn({
          organisation: {
            findUnique: async () => ({ id: 'o1', name: 'Test Org', isActive: true }),
          },
          user: {
            findUnique: async () => userRow,
            update: async ({ data }: { data: { status: 'active' | 'disabled' } }) => {
              userRow = { ...userRow, status: data.status };
              return userRow;
            },
          },
        }),
    };

    const svc = new UsersService(fake as never, audit as never, passwordsStub as never, mailerStub as never);

    // Disable user
    const resDisabled = await orgContext.run({ requestId: 'r', actorId: 'admin1', orgId: 'o1', role: 'system_admin' }, () =>
      svc.updateUserStatusForOrg('o1', 'u3', { status: 'disabled', reason: 'Policy violation' }),
    );
    expect(resDisabled.status).toBe('disabled');
    expect(recorded.some((a) => a.action === 'USER_DISABLED_BY_SYSTEM_ADMIN')).toBe(true);

    // Enable user
    const resEnabled = await orgContext.run({ requestId: 'r', actorId: 'admin1', orgId: 'o1', role: 'system_admin' }, () =>
      svc.updateUserStatusForOrg('o1', 'u3', { status: 'active' }),
    );
    expect(resEnabled.status).toBe('active');
    expect(recorded.some((a) => a.action === 'USER_ENABLED_BY_SYSTEM_ADMIN')).toBe(true);
  });

  it('updateUserStatusForOrg rejects enabling user in an inactive organization', async () => {
    const fake = {
      runAsSupervisor: async (fn: (tx: unknown) => unknown) =>
        fn({
          organisation: {
            findUnique: async () => ({ id: 'o1', name: 'Test Org', isActive: false }),
          },
        }),
    };
    const svc = new UsersService(fake as never, auditStub as never, passwordsStub as never, mailerStub as never);
    await expect(
      orgContext.run({ requestId: 'r', actorId: 'admin1', orgId: 'o1', role: 'system_admin' }, () =>
        svc.updateUserStatusForOrg('o1', 'u3', { status: 'active' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateUserStatusForOrg prevents System Admin from disabling self', async () => {
    const fake = {
      runAsSupervisor: async (fn: (tx: unknown) => unknown) =>
        fn({
          organisation: {
            findUnique: async () => ({ id: 'o1', name: 'Test Org', isActive: true }),
          },
        }),
    };
    const svc = new UsersService(fake as never, auditStub as never, passwordsStub as never, mailerStub as never);
    await expect(
      orgContext.run({ requestId: 'r', actorId: 'sys-self', orgId: 'o1', role: 'system_admin' }, () =>
        svc.updateUserStatusForOrg('o1', 'sys-self', { status: 'disabled' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects cross-org user management for non-system_admin roles', async () => {
    const svc = new UsersService({} as never, auditStub as never, passwordsStub as never, mailerStub as never);
    await expect(
      orgContext.run({ requestId: 'r', actorId: 'ngo1', orgId: 'o1', role: 'ngo_admin' }, () =>
        svc.updateUserStatusForOrg('o1', 'u3', { status: 'disabled' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
