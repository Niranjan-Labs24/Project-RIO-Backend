import { orgContext } from '../../tenancy/org-context';
import { OrganizationsService } from './organizations.service';
import type { OrgRow } from './organizations.types';

const baseRow: OrgRow = {
  id: 'o1', name: 'Old', purpose: 'WASH access', registrationNumber: 'REG-OLD-1',
  region: ['North'], email: null, sector: 'wash',
  logoUrl: null, villages: ['A'], regionId: null, governorateIds: [], centerIds: [],
  isActive: true, createdAt: new Date('2026-01-01T00:00:00Z'),
};

function fakeTenant(initial: OrgRow) {
  // Mutable across calls within a single `runInOrgContext` — mirrors a real
  // transaction where update() followed by a re-fetch sees its own write.
  let state = initial;
  const toRaw = (row: OrgRow) => ({
    ...row,
    orgGovernorates: row.governorateIds.map((governorateId) => ({ governorateId })),
    orgCenters: row.centerIds.map((centerId) => ({ centerId })),
  });
  return {
    runInOrgContext: async (fn: (tx: unknown) => unknown) =>
      fn({
        organisation: {
          findFirst: async () => toRaw(state),
          update: async ({ data }: { data: Record<string, unknown> }) => {
            state = { ...state, ...data };
            return toRaw(state);
          },
        },
        organisationGovernorate: {
          deleteMany: async () => {
            state = { ...state, governorateIds: [] };
            return {};
          },
          createMany: async ({ data }: { data: { governorateId: string }[] }) => {
            state = { ...state, governorateIds: data.map((d) => d.governorateId) };
            return {};
          },
        },
        organisationCenter: {
          deleteMany: async () => {
            state = { ...state, centerIds: [] };
            return {};
          },
          createMany: async ({ data }: { data: { centerId: string }[] }) => {
            state = { ...state, centerIds: data.map((d) => d.centerId) };
            return {};
          },
        },
      }),
  };
}

const domainsStub = {
  listDomains: async () => [{ id: 'd1', code: 'W', name: 'Water & Sanitation', isActive: true }],
};

const geographyStub = {
  validateHierarchy: async () => undefined,
};

describe('OrganizationsService', () => {
  it('getCurrent maps a row to Organization with an ISO createdAt', async () => {
    const svc = new OrganizationsService(fakeTenant(baseRow) as never, { record: async () => {} } as never, {} as never, domainsStub as never, geographyStub as never);
    const org = await orgContext.run({ requestId: 'r', orgId: 'o1' }, () => svc.getCurrent());
    expect(org.name).toBe('Old');
    expect(org.createdAt).toBe(new Date('2026-01-01T00:00:00Z').toISOString());
  });

  it('updateCurrent computes changes and records an edit audit event', async () => {
    const recorded: { changes?: { field: string; before: unknown; after: unknown }[] }[] = [];
    const audit = { record: async (i: unknown) => { recorded.push(i as never); } };
    const svc = new OrganizationsService(fakeTenant(baseRow) as never, audit as never, {} as never, domainsStub as never, geographyStub as never);
    const result = await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role: 'ngo_admin' }, () =>
      svc.updateCurrent({ name: 'New' }),
    );
    expect(result.name).toBe('New');
    expect(recorded).toHaveLength(1);
    const firstRecorded = recorded[0];
    expect(firstRecorded).toBeDefined();
    expect(firstRecorded?.changes?.[0]).toMatchObject({ field: 'name', before: 'Old', after: 'New' });
  });

  it('updateCurrent records nothing when no field actually changes', async () => {
    const recorded: unknown[] = [];
    const audit = { record: async (i: unknown) => { recorded.push(i); } };
    const svc = new OrganizationsService(fakeTenant(baseRow) as never, audit as never, {} as never, domainsStub as never, geographyStub as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', role: 'ngo_admin' }, () => svc.updateCurrent({ name: 'Old' }));
    expect(recorded).toHaveLength(0);
  });
});
