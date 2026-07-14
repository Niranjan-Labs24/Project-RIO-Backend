import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

// Requires a running, migrated, seeded DB (admins: admin@demo-ngo.org = ngo_admin,
// sysadmin@platform.local = system_admin; password Passw0rd!).
describe('Organizations (e2e)', () => {
  let app: INestApplication;
  let adminToken: string; // ngo_admin
  let sysToken: string; // system_admin
  const uniq = Date.now();

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'Passw0rd!' }).expect(200);
    return res.body.token;
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
    const region = `Region-${uniq}`;
    const res = await request(app.getHttpServer())
      .patch('/api/organizations/current').set('Authorization', `Bearer ${adminToken}`)
      .send({ region }).expect(200);
    expect(res.body.region).toBe(region);
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
    const name = `New NGO ${uniq}`;
    const res = await request(app.getHttpServer())
      .post('/api/organizations').set('Authorization', `Bearer ${sysToken}`)
      .send({ name, purpose: 'Testing', registrationNumber: `REG-${uniq}`, region: 'North', email: `org-${uniq}@example.org`, sector: 'education', villages: ['V1'], adminName: 'First Admin', adminEmail: `admin-${uniq}@example.org` })
      .expect(201);
    expect(res.body.name).toBe(name);
    expect(typeof res.body.id).toBe('string');

    // The new org has exactly its first admin.
    const byId = await request(app.getHttpServer())
      .get(`/api/organizations/${res.body.id}`).set('Authorization', `Bearer ${sysToken}`).expect(200);
    expect(byId.body.memberCount).toBe(1);
  });

  it('rejects a duplicate registrationNumber with a clean 409 (not a raw 500)', async () => {
    // Same registrationNumber as the org created above — the unique constraint
    // must surface as ORGANIZATION_ALREADY_REGISTERED, mirroring public signup.
    const res = await request(app.getHttpServer())
      .post('/api/organizations').set('Authorization', `Bearer ${sysToken}`)
      .send({ name: `Dup NGO ${uniq}`, purpose: 'Testing', registrationNumber: `REG-${uniq}`, adminName: 'Dup Admin', adminEmail: `dup-${uniq}@example.org` });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORGANIZATION_ALREADY_REGISTERED');
  });
});
