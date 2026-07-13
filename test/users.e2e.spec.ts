import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

// Requires a running, migrated, seeded DB.
describe('Users (e2e)', () => {
  let app: INestApplication;
  let adminToken: string; // ngo_admin
  let sysToken: string; // system_admin
  const uniq = Date.now();
  let invitedId: string;

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

  it('ngo_admin invites a user (status invited)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Field Person', email: `invitee-${uniq}@example.org`, roleId: 'role_field_researcher' })
      .expect(201);
    expect(res.body.status).toBe('invited');
    expect(res.body.role.key).toBe('field_researcher');
    invitedId = res.body.id;
  });

  it('ngo_admin lists its org users (includes the invitee)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/users').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((u: { id: string }) => u.id === invitedId)).toBe(true);
  });

  it('ngo_admin activates the invited user', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/users/${invitedId}`).set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'active' }).expect(200);
    expect(res.body.status).toBe('active');
  });

  it('forbids a non-crossEntity role from cross-org listing (RLS boundary)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/users?organizationId=00000000-0000-0000-0000-000000000009')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it('system_admin lists another org\'s users via ?organizationId', async () => {
    const orgs = await request(app.getHttpServer())
      .get('/api/organizations').set('Authorization', `Bearer ${sysToken}`).expect(200);
    const demo = orgs.body.find((o: { name: string }) => o.name === 'Demo NGO');
    expect(demo).toBeDefined();
    const res = await request(app.getHttpServer())
      .get(`/api/users?organizationId=${demo.id}`).set('Authorization', `Bearer ${sysToken}`).expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });
});
