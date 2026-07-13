import { BadRequestException } from '@nestjs/common';
import { orgContext } from '../../tenancy/org-context';
import { UsersService } from './users.service';
import type { UserRow } from './users.types';

function fakeTenant(opts: { rows?: UserRow[]; current?: UserRow | null }) {
  return {
    runInOrgContext: async (fn: (tx: unknown) => unknown) =>
      fn({
        user: {
          findMany: async () => opts.rows ?? [],
          create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', createdAt: new Date('2026-01-01T00:00:00Z'), ...data }),
          findUnique: async () => opts.current ?? null,
          update: async ({ data }: { data: Record<string, unknown> }) => ({ ...(opts.current as object), ...data }),
        },
      }),
  };
}

const auditStub = { record: async () => {} };

describe('UsersService', () => {
  it('list maps rows to OrgUser with role summary and status', async () => {
    const rows: UserRow[] = [
      { id: 'u1', name: 'A', email: 'a@x.org', roleId: 'role_ngo_admin', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') },
    ];
    const svc = new UsersService(fakeTenant({ rows }) as never, auditStub as never);
    const users = await orgContext.run({ requestId: 'r', orgId: 'o1' }, () => svc.list());
    expect(users[0].role.key).toBe('ngo_admin');
    expect(users[0].status).toBe('active');
  });

  it('invite rejects an invalid roleId', async () => {
    const svc = new UsersService(fakeTenant({}) as never, auditStub as never);
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1' }, () => svc.invite({ name: 'X', email: 'x@x.org', roleId: 'role_bogus' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('invite creates an invited user and records an audit event', async () => {
    const recorded: unknown[] = [];
    const audit = { record: async (i: unknown) => { recorded.push(i); } };
    const svc = new UsersService(fakeTenant({}) as never, audit as never);
    const u = await orgContext.run({ requestId: 'r', orgId: 'o1' }, () =>
      svc.invite({ name: 'New', email: 'n@x.org', roleId: 'role_field_researcher' }),
    );
    expect(u.status).toBe('invited');
    expect(u.role.key).toBe('field_researcher');
    expect(recorded).toHaveLength(1);
  });

  it('update computes changes and records an edit', async () => {
    const current: UserRow = { id: 'u1', name: 'Old', email: 'o@x.org', roleId: 'role_field_researcher', status: 'invited', createdAt: new Date('2026-01-01T00:00:00Z') };
    const recorded: { changes?: { field: string; before: unknown; after: unknown }[] }[] = [];
    const audit = { record: async (i: unknown) => { recorded.push(i as never); } };
    const svc = new UsersService(fakeTenant({ current }) as never, audit as never);
    const u = await orgContext.run({ requestId: 'r', orgId: 'o1' }, () => svc.update('u1', { status: 'active' }));
    expect(u.status).toBe('active');
    expect(recorded[0].changes?.[0]).toMatchObject({ field: 'status', before: 'invited', after: 'active' });
  });
});
