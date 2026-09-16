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

  it('bounds the user list with limit (NFR-006 pagination)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/users?limit=1').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(res.body.length).toBeLessThanOrEqual(1);
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

  async function findUser(token: string, email: string, organizationId?: string): Promise<{ id: string; email: string } | undefined> {
    const url = organizationId ? `/api/users?organizationId=${organizationId}` : '/api/users';
    const res = await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`).expect(200);
    return (res.body as { id: string; email: string }[]).find((u) => u.email === email);
  }

  it('ngo_admin cannot delete its own account (400)', async () => {
    const me = await findUser(adminToken, 'admin@demo-ngo.org');
    expect(me).toBeDefined();
    const res = await request(app.getHttpServer())
      .delete(`/api/users/${me!.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANNOT_REMOVE_SELF');
  });

  it('ngo_admin delete of an unknown id 404s', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/users/00000000-0000-0000-0000-0000000000ff').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('ngo_admin cannot delete a crossEntity account sharing its org (403)', async () => {
    // RIO-RBAC-002 (client-confirmed, 2026-08-27 round): System Admin and
    // System Reviewer are seeded into their own dedicated platform org now,
    // not Demo NGO, so they can no longer stand in for "a crossEntity
    // account that happens to share this org" — Center Supervisor is the
    // real-world case that still does (an entity-account-bound crossEntity
    // role, created inside a specific org). Uses the new X-Act-As-Org
    // header so System Admin (platform-wide) can create it inside Demo NGO
    // specifically, rather than its own platform org.
    const orgs = await request(app.getHttpServer())
      .get('/api/organizations').set('Authorization', `Bearer ${sysToken}`).expect(200);
    const demoOrg = orgs.body.find((o: { name: string }) => o.name === 'Demo NGO');
    expect(demoOrg).toBeDefined();

    const invite = await request(app.getHttpServer())
      .post('/api/users').set('Authorization', `Bearer ${sysToken}`).set('X-Act-As-Org', demoOrg.id)
      .send({ name: 'Test Supervisor', email: `supervisor-${uniq}@demo-ngo.org`, roleId: 'role_center_supervisor' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .delete(`/api/users/${invite.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_USER_REMOVAL');
  });

  it('ngo_admin cannot delete a user in another org — RLS hides it as 404', async () => {
    const orgs = await request(app.getHttpServer())
      .get('/api/organizations').set('Authorization', `Bearer ${sysToken}`).expect(200);
    const riverside = orgs.body.find((o: { name: string }) => o.name === 'Riverside Community Trust');
    expect(riverside).toBeDefined();
    const otherAdmin = await findUser(sysToken, 'admin@riverside-ngo.org', riverside.id);
    expect(otherAdmin).toBeDefined();
    const res = await request(app.getHttpServer())
      .delete(`/api/users/${otherAdmin!.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404); // not 403 — the row is invisible under the caller's org RLS
  });

  it('ngo_admin deletes an invited user (204) and it disappears from the list', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/users/${invitedId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
    const after = await findUser(adminToken, `invitee-${uniq}@example.org`);
    expect(after).toBeUndefined();
  });
});
