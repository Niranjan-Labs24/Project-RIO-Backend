import { describe, expect, it } from 'vitest';
import { orgContext } from '../../tenancy/org-context';
import { AuditService } from './audit.service';

function fakeTenant() {
  const rows: Record<string, unknown>[] = [];
  const tenant = {
    runInOrgContext: async (fn: (tx: any) => any) =>
      fn({
        auditLog: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            rows.push(data);
            return data;
          },
          findUnique: async () => ({
            id: 'a1',
            organisationId: 'o1',
            actorUserId: 'u1',
            action: 'USER_INVITED',
            entityType: 'user',
            entityId: 'u2',
            entityLabel: 'New User',
            metadata: {
              password: 'SecretPassword123!',
              role: 'ngo_admin',
              changes: [{ field: 'password', before: 'oldSecret', after: 'newSecret' }],
            },
            createdAt: new Date(),
          }),
          count: async () => 10,
          findMany: async () => [
            {
              id: 'a1',
              organisationId: 'o1',
              actorUserId: 'u1',
              action: 'ORGANIZATION_DEACTIVATED',
              entityType: 'organization',
              entityId: 'o1',
              entityLabel: 'Demo Org',
              createdAt: new Date(),
            },
          ],
        },
        user: {
          findMany: async () => [{ id: 'u1', name: 'Admin User', email: 'admin@demo.org' }],
        },
      }),
    runAsOrg: async (_orgId: string, fn: (tx: any) => any) =>
      fn({
        auditLog: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            rows.push(data);
            return data;
          },
        },
      }),
    runAsSupervisor: async (fn: (tx: any) => any) =>
      fn({
        auditLog: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            rows.push(data);
            return data;
          },
          findUnique: async () => ({
            id: 'a1',
            organisationId: 'o1',
            actorUserId: 'u1',
            action: 'USER_INVITED',
            entityType: 'user',
            entityId: 'u2',
            entityLabel: 'New User',
            metadata: {
              password: 'SecretPassword123!',
              role: 'ngo_admin',
              changes: [{ field: 'password', before: 'oldSecret', after: 'newSecret' }],
            },
            createdAt: new Date(),
          }),
          count: async () => 10,
          findMany: async () => [
            {
              id: 'a1',
              organisationId: 'o1',
              actorUserId: 'u1',
              action: 'ORGANIZATION_DEACTIVATED',
              entityType: 'organization',
              entityId: 'o1',
              entityLabel: 'Demo Org',
              createdAt: new Date(),
            },
          ],
        },
        user: {
          findMany: async () => [{ id: 'u1', name: 'Admin User', email: 'admin@demo.org' }],
        },
      }),
  };
  return { rows, tenant };
}

describe('AuditService', () => {
  it('record writes an append-only row with actor/org/ip/ua', async () => {
    const { rows, tenant } = fakeTenant();
    const svc = new AuditService(tenant as any);
    await orgContext.run(
      { requestId: 'r', orgId: 'o1', actorId: 'u1', ip: '1.2.3.4', userAgent: 'jest' },
      () =>
        svc.record({
          action: 'edit',
          entityType: 'organization',
          entityId: 'o1',
          entityLabel: 'Demo NGO',
          changes: [{ field: 'name', before: 'A', after: 'B' }],
        }),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.organisationId).toBe('o1');
    expect(row.actorUserId).toBe('u1');
    expect(row.action).toBe('edit');
  });

  it('getById redacts sensitive password fields in metadata and changes', async () => {
    const { tenant } = fakeTenant();
    const svc = new AuditService(tenant as any);
    const detail = await orgContext.run(
      { requestId: 'r', actorId: 'u1', role: 'system_admin' },
      () => svc.getById('a1'),
    );

    expect(detail).toBeDefined();
    expect(detail.metadata?.password).toBe('[REDACTED]');
    expect(detail.changes?.[0]?.before).toBe('[REDACTED]');
    expect(detail.changes?.[0]?.after).toBe('[REDACTED]');
  });

  it('getSummary aggregates governance metrics', async () => {
    const { tenant } = fakeTenant();
    const svc = new AuditService(tenant as any);
    const summary = await orgContext.run(
      { requestId: 'r', actorId: 'u1', role: 'system_admin' },
      () => svc.getSummary(),
    );

    expect(summary).toBeDefined();
    expect(summary.stats.totalEvents).toBe(10);
    expect(summary.recentDeactivatedOrgs).toHaveLength(1);
  });
});
