import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma';
import { makeFakeTx } from '../../../test/support/fake-tx';
import { orgContext } from '../../tenancy/org-context';
import { OrganizationsService } from './organizations.service';

function setup() {
  const tx = makeFakeTx();
  const call = async (fn: (t: unknown) => unknown) => fn(tx);
  const tenant = {
    runInOrgContext: call,
    runAsSupervisor: call,
    runAsOrg: (_o: string, fn: (t: unknown) => unknown) => call(fn),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const passwords = { hash: vi.fn().mockResolvedValue('hash') };
  const domains = {
    listDomains: vi.fn().mockResolvedValue([
      { name: 'Water', isActive: true },
      { name: 'Old', isActive: false },
    ]),
  };
  const geography = { validateHierarchy: vi.fn().mockResolvedValue(undefined) };
  const mailer = { sendTemporaryPassword: vi.fn().mockResolvedValue(true) };
  const nic = { assertRegistered: vi.fn().mockResolvedValue('8123456789') };
  const consent = {
    getActivePolicy: vi.fn(async (kind: string) => ({
      version: 'v1',
      text: `${kind} en`,
      textAr: kind === 'use_policy' ? 'ar text' : null,
    })),
  };
  const svc = new OrganizationsService(
    tenant as never,
    audit as never,
    passwords as never,
    domains as never,
    geography as never,
    mailer as never,
    nic as never,
    consent as never,
  );
  return { tx, audit, passwords, geography, mailer, nic, consent, svc };
}
const as = <T>(role: string | undefined, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role } as never, fn);
const code = (c: string) =>
  expect.objectContaining({ response: { error: expect.objectContaining({ code: c }) } });
const raw = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  name: 'Org',
  purpose: null,
  registrationNumber: 'R',
  logoUrl: null,
  region: [],
  email: null,
  sector: 'Water',
  villages: [],
  regionId: 'r1',
  isActive: true,
  approvedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  orgGovernorates: [{ governorateId: 'g1' }],
  orgCenters: [{ centerId: 'c1' }],
  ...over,
});
const withStats = (over: Record<string, unknown> = {}) =>
  raw({
    users: [{ name: 'Admin', email: 'a@x.org' }],
    _count: { users: 2, studies: 1, surveys: 1, reports: 3 },
    ...over,
  });
const payload = (over: Record<string, unknown> = {}) => ({
  name: 'New Org',
  sector: 'Water',
  registrationNumber: '8123456789',
  regionId: 'r1',
  governorateIds: ['g1'],
  centerIds: ['c1'],
  adminName: 'Amy',
  adminEmail: 'amy@x.org',
  adminMobileNumber: ' (05) 123-4567 ',
  consent: { usePolicyVersion: 'v1', dataSharingVersion: 'v1', locale: 'ar' },
  ...over,
});

describe('OrganizationsService current organisation', () => {
  it('refuses when the organisation is missing', async () => {
    const { svc, tx } = setup();
    tx.organisation.findFirst.mockResolvedValue(null);
    await expect(as('ngo_admin', () => svc.getCurrent())).rejects.toThrow(code('ORG_NOT_FOUND'));
    await expect(as('ngo_admin', () => svc.updateCurrent({ name: 'x' }))).rejects.toThrow(
      code('ORG_NOT_FOUND'),
    );
  });

  it('updates every field, replacing geography and auditing what changed (hiding the logo image)', async () => {
    const { svc, tx, audit, geography } = setup();
    tx.organisation.findFirst.mockResolvedValue(raw({ logoUrl: 'data:old' }));
    await as('ngo_admin', () =>
      svc.updateCurrent({
        name: 'N',
        region: ['x'],
        email: 'e@x.org',
        sector: 'Water',
        purpose: 'p',
        logoUrl: 'data:new',
        villages: ['v'],
        regionId: 'r2',
        isActive: false,
        governorateIds: ['g2', 'g3'],
        centerIds: [],
      } as never),
    );
    expect(geography.validateHierarchy).toHaveBeenCalledWith({
      regionId: 'r2',
      governorateIds: ['g2', 'g3'],
      centerIds: [],
    });
    expect(tx.organisationGovernorate.createMany).toHaveBeenCalled();
    expect(tx.organisationCenter.createMany).not.toHaveBeenCalled();
    const changes = audit.record.mock.calls[0]![0].changes as Array<{
      before: unknown;
      after: unknown;
    }>;
    expect(changes.some((c) => c.before === '(logo)' && c.after === '(logo)')).toBe(true);
    expect(changes.length).toBeGreaterThan(8);
  });

  it('audits a logo being added or removed, and centre changes, and skips unchanged geography', async () => {
    const { svc, tx, audit } = setup();
    tx.organisation.findFirst.mockResolvedValue(raw());
    await as('ngo_admin', () =>
      svc.updateCurrent({
        logoUrl: 'data:new',
        centerIds: ['c1', 'c2'],
        governorateIds: ['g1'],
      } as never),
    );
    const changes = audit.record.mock.calls[0]![0].changes as Array<{
      before: unknown;
      after: unknown;
    }>;
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ before: null, after: '(logo)' });
    tx.organisation.findFirst.mockResolvedValue(raw({ logoUrl: 'data:old' }));
    await as('ngo_admin', () => svc.updateCurrent({ logoUrl: null, sector: null } as never));
    expect(
      (audit.record.mock.calls[1]![0].changes as Array<{ after: unknown }>)[0]!.after,
    ).toBeNull();
  });

  it('rejects an unknown sector but accepts "other" and none', async () => {
    const { svc, tx } = setup();
    tx.organisation.findFirst.mockResolvedValue(raw());
    await expect(as('ngo_admin', () => svc.updateCurrent({ sector: 'Nope' }))).rejects.toThrow(
      code('INVALID_SECTOR'),
    );
    await expect(as('ngo_admin', () => svc.updateCurrent({ sector: 'Old' }))).rejects.toThrow(
      code('INVALID_SECTOR'),
    );
    await as('ngo_admin', () => svc.updateCurrent({ sector: 'other' }));
    await as('ngo_admin', () => svc.updateCurrent({ sector: '' }));
  });
});

describe('OrganizationsService.createWithAdmin', () => {
  it('creates the organisation and an invited admin with both consents, then emails the temporary password', async () => {
    const { svc, tx, mailer, audit } = setup();
    tx.organisation.create.mockResolvedValue(
      raw({ id: 'new', name: 'New Org', registrationNumber: '8123456789' }),
    );
    tx.user.create.mockResolvedValue({ id: 'usr' });
    const out = await as('system_admin', () => svc.createWithAdmin(payload() as never));
    expect(out.name).toBe('New Org');
    expect(tx.user.create.mock.calls[0]![0].data).toMatchObject({
      mobileNumber: '051234567',
      mustChangePassword: true,
      consentedPolicyVersion: 'v1',
    });
    const acceptances = tx.consentAcceptance.createMany.mock.calls[0]![0].data as Array<{
      policyLocale: string;
      policyText: string;
    }>;
    expect(acceptances.map((a) => a.policyLocale).sort()).toEqual(['ar', 'en']);
    expect(mailer.sendTemporaryPassword).toHaveBeenCalled();
    expect(audit.record.mock.calls[0]![0].action).toBe('ORGANIZATION_CREATED');
  });

  it('creates an organisation alone, without an admin, consent or email', async () => {
    const { svc, tx, mailer, consent } = setup();
    tx.organisation.create.mockResolvedValue(raw());
    await as('system_admin', () =>
      svc.createWithAdmin(
        payload({
          adminName: undefined,
          adminEmail: undefined,
          purpose: 'p',
          region: ['x'],
          email: 'e@x.org',
          villages: ['v'],
        }) as never,
      ),
    );
    expect(consent.getActivePolicy).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(mailer.sendTemporaryPassword).not.toHaveBeenCalled();
  });

  it('records no mobile number when none is given, and no consent columns for a missing policy', async () => {
    const { svc, tx, consent } = setup();
    tx.organisation.create.mockResolvedValue(raw());
    tx.user.create.mockResolvedValue({ id: 'usr' });
    consent.getActivePolicy.mockImplementation(async () => ({
      version: 'v1',
      text: 't',
      textAr: null,
    }));
    await as('system_admin', () =>
      svc.createWithAdmin(
        payload({
          adminMobileNumber: undefined,
          consent: { usePolicyVersion: 'v1', dataSharingVersion: 'v1' },
        }) as never,
      ),
    );
    expect(tx.user.create.mock.calls[0]![0].data.mobileNumber).toBeNull();
    expect(tx.consentAcceptance.createMany.mock.calls[0]![0].data[0].policyLocale).toBe('en');
  });

  it('refuses without consent, with a stale consent version, or from a non cross-entity role', async () => {
    const { svc } = setup();
    await expect(as('ngo_admin', () => svc.createWithAdmin(payload() as never))).rejects.toThrow(
      code('FORBIDDEN'),
    );
    await expect(as(undefined, () => svc.createWithAdmin(payload() as never))).rejects.toThrow(
      code('FORBIDDEN'),
    );
    await expect(
      as('system_admin', () => svc.createWithAdmin(payload({ consent: undefined }) as never)),
    ).rejects.toThrow(code('CONSENT_REQUIRED'));
    await expect(
      as('system_admin', () =>
        svc.createWithAdmin(
          payload({ consent: { usePolicyVersion: 'old', dataSharingVersion: 'v1' } }) as never,
        ),
      ),
    ).rejects.toThrow(code('CONSENT_VERSION_STALE'));
  });

  it('maps duplicate registration numbers and emails to conflicts, and passes other errors on', async () => {
    const { svc, tx } = setup();
    const dup = (msg: string) =>
      new Prisma.PrismaClientKnownRequestError('x', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { driverAdapterError: { cause: { originalMessage: msg } } },
      });
    tx.organisation.create.mockRejectedValueOnce(dup('organisations_registration_number_key'));
    await expect(as('system_admin', () => svc.createWithAdmin(payload() as never))).rejects.toThrow(
      code('ORGANIZATION_ALREADY_REGISTERED'),
    );
    tx.organisation.create.mockRejectedValueOnce(dup('users_email_key'));
    await expect(as('system_admin', () => svc.createWithAdmin(payload() as never))).rejects.toThrow(
      code('EMAIL_ALREADY_REGISTERED'),
    );
    const other = new Error('boom');
    tx.organisation.create.mockRejectedValueOnce(other);
    await expect(as('system_admin', () => svc.createWithAdmin(payload() as never))).rejects.toBe(
      other,
    );
  });
});

describe('OrganizationsService cross-entity reads and status', () => {
  it('lists organisations with counts, clamping the page', async () => {
    const { svc, tx } = setup();
    tx.organisation.findMany.mockResolvedValue([withStats(), withStats({ id: 'o2', users: [] })]);
    tx.report.groupBy.mockResolvedValue([{ orgId: 'o1', _count: { _all: 2 } }]);
    tx.surveyResponse.groupBy.mockResolvedValue([{ orgId: 'o1', _count: { _all: 9 } }]);
    const out = await as('system_admin', () => svc.listAll({ limit: 999, offset: -1 }));
    expect(tx.organisation.findMany.mock.calls[0]![0]).toMatchObject({ take: 200, skip: 0 });
    expect(out[0]).toMatchObject({
      publishedReportCount: 2,
      responseCount: 9,
      ngoAdminName: 'Admin',
    });
    expect(out[1]).toMatchObject({
      publishedReportCount: 0,
      responseCount: 0,
      ngoAdminName: null,
      ngoAdminEmail: null,
    });
    await as('center_supervisor', () => svc.listAll());
    expect(tx.organisation.findMany.mock.calls[1]![0]).toMatchObject({ take: 100, skip: 0 });
  });

  it('returns an organisation and audits the view, or refuses an unknown one', async () => {
    const { svc, tx, audit } = setup();
    tx.organisation.findUnique
      .mockResolvedValueOnce(withStats())
      .mockResolvedValueOnce(withStats({ users: [] }))
      .mockResolvedValueOnce(null);
    expect(await as('system_admin', () => svc.getById('o1'))).toMatchObject({
      memberCount: 2,
      ngoAdminEmail: 'a@x.org',
    });
    expect((await as('system_admin', () => svc.getById('o1'))).ngoAdminName).toBeNull();
    expect(audit.record).toHaveBeenCalledTimes(2);
    await expect(as('system_admin', () => svc.getById('x'))).rejects.toThrow(code('ORG_NOT_FOUND'));
  });

  it('reactivates and deactivates, noting a reason only when given', async () => {
    const { svc, tx, audit } = setup();
    tx.organisation.findUnique.mockResolvedValue(withStats());
    await as('system_admin', () => svc.updateStatus('o1', { isActive: true }));
    expect(audit.record.mock.calls[0]![0]).toMatchObject({
      action: 'ORGANIZATION_REACTIVATED',
      metadata: undefined,
    });
    tx.organisation.findUnique.mockResolvedValueOnce(null);
    await expect(
      as('system_admin', () => svc.updateStatus('x', { isActive: false })),
    ).rejects.toThrow(code('ORG_NOT_FOUND'));
  });

  it('approves a self-registered entity, issuing the temporary password', async () => {
    const { svc, tx, mailer, passwords, audit } = setup();
    tx.organisation.findUnique
      .mockResolvedValueOnce(
        withStats({ approvedAt: null, users: [{ id: 'adm', email: 'a@x.org' }] }),
      )
      .mockResolvedValueOnce(withStats());
    await as('system_admin', () => svc.approve('o1'));
    expect(passwords.hash).toHaveBeenCalled();
    expect(tx.user.update.mock.calls[0]![0].data).toMatchObject({ mustChangePassword: true });
    expect(mailer.sendTemporaryPassword).toHaveBeenCalledWith('a@x.org', 'Org', expect.any(String));
    expect(audit.record.mock.calls[0]![0].action).toBe('ORGANIZATION_APPROVED');
  });

  it('refuses to approve an unknown, already approved or admin-less organisation', async () => {
    const { svc, tx } = setup();
    tx.organisation.findUnique.mockResolvedValueOnce(null);
    await expect(as('system_admin', () => svc.approve('x'))).rejects.toThrow(code('ORG_NOT_FOUND'));
    tx.organisation.findUnique.mockResolvedValueOnce(
      withStats({ approvedAt: new Date(), users: [{ id: 'a', email: 'e' }] }),
    );
    await expect(as('system_admin', () => svc.approve('o1'))).rejects.toThrow(
      code('ORG_ALREADY_APPROVED'),
    );
    tx.organisation.findUnique.mockResolvedValueOnce(withStats({ approvedAt: null, users: [] }));
    await expect(as('system_admin', () => svc.approve('o1'))).rejects.toThrow(
      code('ORG_ADMIN_NOT_FOUND'),
    );
  });
});
