import { orgContext } from '../../tenancy/org-context';
import { AuditService } from './audit.service';

function fakeTenant() {
  const rows: Record<string, unknown>[] = [];
  const tenant = {
    runInOrgContext: async (fn: (tx: unknown) => unknown) =>
      fn({ auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); return data; } } }),
  };
  return { rows, tenant };
}

describe('AuditService.record', () => {
  it('writes an append-only row with actor/org/ip/ua from the OrgStore and changes in metadata', async () => {
    const { rows, tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
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
    expect(row.entityType).toBe('organization');
    expect(row.ipAddress).toBe('1.2.3.4');
    expect(row.userAgent).toBe('jest');
    expect((row.metadata as { changes: { after: string }[] }).changes[0]?.after).toBe('B');
  });
});
