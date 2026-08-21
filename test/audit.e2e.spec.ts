import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

// Requires a running, migrated, seeded DB. Logging in records a 'login' audit
// event; GET /api/audit should return it.
//
// Driven by the platform System Admin, not an NGO Admin: RIO-NFR-004 moved
// every audit.controller.ts route off `archiveSharingAudit` onto the dedicated
// `auditLog` module (see role-matrix.ts), which only system_admin and
// center_supervisor hold. An ngo_admin token now gets a 403 here by design —
// pinned by the last test in this file so the lockout can't silently regress.
describe('Audit (e2e)', () => {
  let app: INestApplication;
  let token: string;
  let sysAdminUserId: string;
  let ngoAdminToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'sysadmin@platform.local', password: 'Passw0rd!' })
      .expect(200);
    token = login.body.token;
    sysAdminUserId = login.body.user.id;

    const ngoLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@demo-ngo.org', password: 'Passw0rd!' })
      .expect(200);
    ngoAdminToken = ngoLogin.body.token;
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns audit events including the login, with actor + action', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/audit')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    // Matched on the actor, not just `action === 'login'`: beforeAll signs in
    // twice (System Admin, then the NGO Admin the lockout test needs), and a
    // System Admin reads across orgs, so the newest 'login' row is not
    // necessarily this suite's own.
    const loginEvent = res.body.items.find(
      (e: { action: string; entityId: string }) => e.action === 'login' && e.entityId === sysAdminUserId,
    );
    expect(loginEvent).toBeDefined();
    expect(loginEvent.entityType).toBe('user');
    expect(loginEvent.actor?.email).toBe('sysadmin@platform.local');
  });

  it('traces a specific entity: filter by entityType + entityId (NFR-004)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/audit?entityType=user&entityId=${sysAdminUserId}&limit=100`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((e: { entityType: string; entityId: string }) => e.entityType === 'user' && e.entityId === sysAdminUserId)).toBe(true);
  });

  it('bounds the result set with limit (NFR-006 pagination)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/audit?limit=1')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.items.length).toBeLessThanOrEqual(1);
    // `total` counts every match, so it isn't clamped by `limit`.
    expect(res.body.total).toBeGreaterThanOrEqual(res.body.items.length);
  });

  it('filters by date range and free-text search (Audit Log page filters)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app.getHttpServer())
      .get(`/api/audit?dateFrom=${today}T00:00:00.000Z&action=login&search=sysadmin@platform.local`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(
      res.body.items.every(
        (e: { action: string; actor: { email: string } | null }) =>
          e.action === 'login' && e.actor?.email === 'sysadmin@platform.local',
      ),
    ).toBe(true);
  });

  // RIO-NFR-004: the Audit Log is System-Admin/Center-Supervisor territory.
  // ngo_admin keeps archiveSharingAudit read/create/approve (Study and Report
  // Sharing, FR-014, still work for it — see sharing.e2e.spec.ts) but holds no
  // `auditLog` grant, so the raw log is closed to it. This is the assertion
  // that would have caught the module split silently widening again.
  it('denies an NGO Admin: the Audit Log is gated on auditLog, not archiveSharingAudit', async () => {
    await request(app.getHttpServer())
      .get('/api/audit')
      .set('Authorization', `Bearer ${ngoAdminToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/audit/export?format=csv')
      .set('Authorization', `Bearer ${ngoAdminToken}`)
      .expect(403);
  });
});
