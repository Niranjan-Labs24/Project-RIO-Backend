import { orgContext } from '../../tenancy/org-context';
import { OrganizationsService } from './organizations.service';
import type { OrgRow } from './organizations.types';

const baseRow: OrgRow = {
  id: 'o1', name: 'Old', region: 'North', email: null, sector: 'wash',
  logoUrl: null, villages: ['A'], isActive: true, createdAt: new Date('2026-01-01T00:00:00Z'),
};

function fakeTenant(current: OrgRow) {
  return {
    runInOrgContext: async (fn: (tx: unknown) => unknown) =>
      fn({
        organisation: {
          findFirst: async () => current,
          update: async ({ data }: { data: Record<string, unknown> }) => ({ ...current, ...data }),
        },
      }),
  };
}

describe('OrganizationsService', () => {
  it('getCurrent maps a row to Organization with an ISO createdAt', async () => {
    const svc = new OrganizationsService(fakeTenant(baseRow) as never, { record: async () => {} } as never, {} as never);
    const org = await orgContext.run({ requestId: 'r', orgId: 'o1' }, () => svc.getCurrent());
    expect(org.name).toBe('Old');
    expect(org.createdAt).toBe(new Date('2026-01-01T00:00:00Z').toISOString());
  });

  it('updateCurrent computes changes and records an edit audit event', async () => {
    const recorded: { changes?: { field: string; before: unknown; after: unknown }[] }[] = [];
    const audit = { record: async (i: unknown) => { recorded.push(i as never); } };
    const svc = new OrganizationsService(fakeTenant(baseRow) as never, audit as never, {} as never);
    const result = await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role: 'ngo_admin' }, () =>
      svc.updateCurrent({ name: 'New' }),
    );
    expect(result.name).toBe('New');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].changes?.[0]).toMatchObject({ field: 'name', before: 'Old', after: 'New' });
  });

  it('updateCurrent records nothing when no field actually changes', async () => {
    const recorded: unknown[] = [];
    const audit = { record: async (i: unknown) => { recorded.push(i); } };
    const svc = new OrganizationsService(fakeTenant(baseRow) as never, audit as never, {} as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', role: 'ngo_admin' }, () => svc.updateCurrent({ name: 'Old' }));
    expect(recorded).toHaveLength(0);
  });
});
