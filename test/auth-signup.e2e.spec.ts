import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { DEFAULT_TEMP_PASSWORD } from '../src/modules/auth/auth.repository';

// Requires a running, migrated, seeded DB (needs sysadmin@platform.local —
// see prisma/seed.ts). Cookie-based, like auth-cookie flows — the app must
// apply cookie-parser middleware the same way src/main.ts does.
//
// RIO-FR-010 (client-confirmed): self-registration requires Center (System
// Admin) approval before activation — signup no longer issues a session,
// and the entity can't log in until a System Admin approves it.
describe('signup -> pending approval -> System Admin approves -> entity logs in', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('blocks login until approved, then lets the entity log in with the temp password System Admin\'s approval issues', async () => {
    const server = app.getHttpServer();
    const rn = `RN-${Date.now()}`;
    const email = `admin+${Date.now()}@e2e.test`;

    // Geography reference endpoints are public (no @RequirePermission — see
    // GeographyController), so these are reachable before the org exists.
    const regions = await request(server).get('/api/regions').expect(200);
    const regionId = regions.body[0].id;
    const governorates = await request(server)
      .get('/api/governorates')
      .query({ regionId })
      .expect(200);
    const governorateId = governorates.body[0].id;
    const centers = await request(server)
      .get('/api/centers')
      .query({ governorateId })
      .expect(200);
    const centerId = centers.body[0].id;

    const signup = await request(server)
      .post('/api/auth/signup')
      .send({
        organizationName: 'E2E NGO',
        purpose: 'testing',
        registrationNumber: rn,
        email,
        regionId,
        governorateIds: [governorateId],
        centerIds: [centerId],
      })
      .expect(201);

    // No session is established at signup — pending approval, nothing else.
    expect(signup.body).toEqual({ status: 'pending_approval', organizationName: 'E2E NGO', email });
    expect(signup.headers['set-cookie']).toBeUndefined();

    // Login is blocked until approved — org.isActive is false from creation.
    await request(server)
      .post('/api/auth/login')
      .send({ email, password: DEFAULT_TEMP_PASSWORD })
      .expect(403)
      .expect((r) => expect(r.body.error.code).toBe('ORG_INACTIVE'));

    // System Admin logs in and approves the pending entity.
    const adminLogin = await request(server)
      .post('/api/auth/login')
      .send({ email: 'sysadmin@platform.local', password: 'Passw0rd!' })
      .expect(200);
    const adminCookies = adminLogin.headers['set-cookie'] as unknown as string[];
    const adminCsrf = adminCookies.find((c) => c.startsWith('rio_csrf='))?.match(/rio_csrf=([^;]*)/)?.[1] ?? '';

    const orgsList = await request(server)
      .get('/api/organizations')
      .set('Cookie', adminCookies)
      .expect(200);
    const pendingOrg = (orgsList.body as Array<{ id: string; registrationNumber: string }>).find(
      (o) => o.registrationNumber === rn,
    );
    expect(pendingOrg).toBeDefined();

    const approved = await request(server)
      .patch(`/api/organizations/${pendingOrg!.id}/approve`)
      .set('Cookie', adminCookies)
      .set('x-csrf-token', adminCsrf)
      .expect(200);
    expect(approved.body.isActive).toBe(true);
    expect(approved.body.approvedAt).toEqual(expect.any(String));

    // Approving twice is rejected — already approved.
    await request(server)
      .patch(`/api/organizations/${pendingOrg!.id}/approve`)
      .set('Cookie', adminCookies)
      .set('x-csrf-token', adminCsrf)
      .expect(400)
      .expect((r) => expect(r.body.error.code).toBe('ORG_ALREADY_APPROVED'));

    // The entity can now log in with the temporary password approval issued
    // (DEFAULT_TEMP_PASSWORD — see OrganizationsService.approve).
    const entityLogin = await request(server)
      .post('/api/auth/login')
      .send({ email, password: DEFAULT_TEMP_PASSWORD })
      .expect(200);
    expect(entityLogin.body.mustChangePassword).toBe(true);
    expect(entityLogin.body.organization.registrationNumber).toBe(rn);
  }, 20_000);
});
