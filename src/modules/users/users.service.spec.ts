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
// A temporary-password stub trio, shared by every test below: hashing is a
// no-op, the mailer reports "not configured" (matching local dev with no
// SMTP set up) so provisionTemporaryPassword takes its dev-only fallback
// branch, and nodeEnv is non-production so that branch doesn't throw.
const passwordsStub = { hash: async () => 'hashed-password' };
const mailerStub = { sendTemporaryPassword: async () => false };
const configStub = { nodeEnv: 'test' };

function makeService(tenant: ReturnType<typeof fakeTenant>, audit: unknown = auditStub) {
  return new UsersService(
    tenant as never,
    audit as never,
    passwordsStub as never,
    mailerStub as never,
    configStub as never,
  );
}

describe('UsersService', () => {
  it('list maps rows to OrgUser with role summary and status', async () => {
    const rows: UserRow[] = [
      { id: 'u1', name: 'A', email: 'a@x.org', roleId: 'role_ngo_admin', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') },
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
    // Mailer stub reports unconfigured — dev-only fallback surfaces the
    // generated password back to the caller instead of silently dropping it.
    expect(u.temporaryPasswordEmailed).toBe(false);
    expect(typeof u.temporaryPassword).toBe('string');
  });

  it('forbids a tenant admin (non-crossEntity) from assigning a crossEntity role (privilege escalation)', async () => {
    const svc = makeService(fakeTenant({}));
    // ngo_admin trying to mint a system_admin (crossEntity) must be blocked.
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1', role: 'ngo_admin' }, () =>
        svc.invite({ name: 'X', email: 'x@x.org', roleId: 'role_system_admin' })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const current: UserRow = { id: 'u1', name: 'Me', email: 'me@x.org', roleId: 'role_ngo_admin', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') };
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
    const current: UserRow = { id: 'u1', name: 'Old', email: 'o@x.org', roleId: 'role_field_researcher', status: 'invited', createdAt: new Date('2026-01-01T00:00:00Z') };
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
    const current: UserRow = { id: 'sys', name: 'System Admin', email: 'sys@x.org', roleId: 'role_system_admin', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') };
    let deleted = false;
    const svc = makeService(fakeTenant({ current, onDelete: () => { deleted = true; } }));
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'me', role: 'ngo_admin' }, () => svc.remove('sys')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deleted).toBe(false); // never reached the delete
  });

  it('removes a regular user and records a delete audit event', async () => {
    const current: UserRow = { id: 'u9', name: 'Field', email: 'field@x.org', roleId: 'role_field_researcher', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') };
    const recorded: { action?: string; entityId?: string; entityLabel?: string }[] = [];
    const audit = { record: async (i: unknown) => { recorded.push(i as never); } };
    let deletedWhere: unknown;
    const svc = makeService(fakeTenant({ current, onDelete: (w) => { deletedWhere = w; } }), audit);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'me', role: 'ngo_admin' }, () => svc.remove('u9'));
    expect(deletedWhere).toEqual({ id: 'u9' });
    expect(recorded[0]).toMatchObject({ action: 'delete', entityId: 'u9', entityLabel: 'field@x.org' });
  });

  it('lets a crossEntity admin (system_admin) remove a crossEntity account', async () => {
    const current: UserRow = { id: 'sys2', name: 'Other System', email: 'sys2@x.org', roleId: 'role_system_admin', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') };
    let deleted = false;
    const svc = makeService(fakeTenant({ current, onDelete: () => { deleted = true; } }));
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'me', role: 'system_admin' }, () => svc.remove('sys2'));
    expect(deleted).toBe(true);
  });
});
