import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';

// Requires a running, migrated, seeded DB (admins: admin@demo-ngo.org = ngo_admin,
// sysadmin@platform.local = system_admin; password Passw0rd!).
describe('Organizations (e2e)', () => {
  let app: INestApplication;
  let adminToken: string; // ngo_admin
  let sysToken: string; // system_admin
  const uniq = Date.now();
  // Populated by the "creates an organization" test, reused by the
  // "duplicate registrationNumber" test right after it.
  let duplicateRegistrationNumber: string;
  let validGeography: { regionId: string; governorateIds: string[]; centerIds: string[] };
  let consentVersions: { usePolicyVersion: string; dataSharingVersion: string };

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'Passw0rd!' }).expect(200);
    return res.body.token;
  }

  // createWithAdmin now gates on the same NIC-registry check as public
  // signup (see auth-signup.e2e.spec.ts's identical helper) — an
  // `REG-${Date.now()}` placeholder no longer gets past it. Each run claims
  // a *real*, still-unused number rather than a fixed fixture that would
  // conflict on a second run.
  async function takeUnusedNicNumber(): Promise<string> {
    const tenant = app.get(TenantPrismaService);
    const nicNumber = await tenant.runAsSupervisor(async (tx) => {
      const used = await tx.organisation.findMany({
        where: { registrationNumber: { not: null } },
        select: { registrationNumber: true },
      });
      const taken = used
        .map((o) => o.registrationNumber)
        .filter((n): n is string => n !== null);
      const row = await tx.nicRegistry.findFirst({
        where: taken.length > 0 ? { nicNumber: { notIn: taken } } : undefined,
        orderBy: { nicNumber: 'asc' },
        select: { nicNumber: true },
      });
      return row?.nicNumber ?? null;
    });
    if (!nicNumber) {
      throw new Error('No unused NIC number available — run `pnpm import:nic-registry` first.');
    }
    return nicNumber;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    adminToken = await login('admin@demo-ngo.org');
    sysToken = await login('sysadmin@platform.local');
  });
  afterAll(async () => {
    await app.close();
  });

  it('ngo_admin reads its current organization', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/organizations/current').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(res.body.name).toBe('Demo NGO');
    expect(Array.isArray(res.body.villages)).toBe(true);
  });

  it('ngo_admin updates its current organization', async () => {
    const regions = [`Region-${uniq}`];
    const res = await request(app.getHttpServer())
      .patch('/api/organizations/current').set('Authorization', `Bearer ${adminToken}`)
      .send({ region: regions }).expect(200);
    expect(res.body.region).toEqual(regions);
  });

  it('system_admin lists all organizations with memberCount', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/organizations').set('Authorization', `Bearer ${sysToken}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(typeof res.body[0].memberCount).toBe('number');
  });

  it('forbids a non-crossEntity role from listing all organizations', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/organizations').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it('system_admin creates an organization with its first admin', async () => {
    const server = app.getHttpServer();
    const rn = await takeUnusedNicNumber();

    // Geography reference endpoints are public (see GeographyController) —
    // same lookup auth-signup.e2e.spec.ts uses to get a real, existing
    // Region/Governorate/Center chain rather than a fixture id.
    const regions = await request(server).get('/api/regions').expect(200);
    const regionId = regions.body[0].id;
    const governorates = await request(server).get('/api/governorates').query({ regionId }).expect(200);
    const governorateId = governorates.body[0].id;
    const centers = await request(server).get('/api/centers').query({ governorateId }).expect(200);
    const centerId = centers.body[0].id;

    // RIO-DATA-001 — an admin created here still needs both consents on
    // record, so the versions have to come from the live policies (public
    // endpoint, same as signup's identical lookup).
    const policies = await request(server).get('/api/consent-policy/active').expect(200);

    const name = `New NGO ${uniq}`;
    const res = await request(server)
      .post('/api/organizations').set('Authorization', `Bearer ${sysToken}`)
      .send({
        name, purpose: 'Testing', registrationNumber: rn, region: ['North'],
        email: `org-${uniq}@example.org`, sector: 'Education', villages: ['V1'],
        regionId, governorateIds: [governorateId], centerIds: [centerId],
        adminName: 'First Admin', adminEmail: `admin-${uniq}@example.org`,
        consent: {
          usePolicyVersion: policies.body.usePolicy.version,
          dataSharingVersion: policies.body.dataSharing.version,
        },
      })
      .expect(201);
    expect(res.body.name).toBe(name);
    expect(typeof res.body.id).toBe('string');

    // The new org has exactly its first admin.
    const byId = await request(server)
      .get(`/api/organizations/${res.body.id}`).set('Authorization', `Bearer ${sysToken}`).expect(200);
    expect(byId.body.memberCount).toBe(1);

    // Reused by the next test — the duplicate check that test exercises has
    // to reach the DB unique constraint (a real, already-verifiable NIC
    // number reused as-is), not fail earlier on an unverifiable placeholder.
    duplicateRegistrationNumber = rn;
    validGeography = { regionId, governorateIds: [governorateId], centerIds: [centerId] };
    consentVersions = {
      usePolicyVersion: policies.body.usePolicy.version,
      dataSharingVersion: policies.body.dataSharing.version,
    };
  });

  it('rejects a duplicate registrationNumber with a clean 409 (not a raw 500)', async () => {
    // Same registrationNumber as the org created above — the unique constraint
    // must surface as ORGANIZATION_ALREADY_REGISTERED, mirroring public signup.
    const res = await request(app.getHttpServer())
      .post('/api/organizations').set('Authorization', `Bearer ${sysToken}`)
      .send({
        name: `Dup NGO ${uniq}`, purpose: 'Testing', registrationNumber: duplicateRegistrationNumber,
        sector: 'Education', ...validGeography,
        adminName: 'Dup Admin', adminEmail: `dup-${uniq}@example.org`,
        consent: consentVersions,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORGANIZATION_ALREADY_REGISTERED');
  });
});
