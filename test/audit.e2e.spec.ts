import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

// Requires a running, migrated, seeded DB. Logging in records a 'login' audit
// event; GET /api/audit should return it.
describe('Audit (e2e)', () => {
  let app: INestApplication;
  let token: string;
  let adminUserId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@demo-ngo.org', password: 'Passw0rd!' })
      .expect(200);
    token = login.body.token;
    adminUserId = login.body.user.id;
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
    const loginEvent = res.body.items.find((e: { action: string }) => e.action === 'login');
    expect(loginEvent).toBeDefined();
    expect(loginEvent.entityType).toBe('user');
    expect(loginEvent.actor?.email).toBe('admin@demo-ngo.org');
  });

  it('traces a specific entity: filter by entityType + entityId (NFR-004)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/audit?entityType=user&entityId=${adminUserId}&limit=100`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((e: { entityType: string; entityId: string }) => e.entityType === 'user' && e.entityId === adminUserId)).toBe(true);
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
      .get(`/api/audit?dateFrom=${today}T00:00:00.000Z&action=login&search=admin@demo-ngo.org`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(
      res.body.items.every(
        (e: { action: string; actor: { email: string } | null }) =>
          e.action === 'login' && e.actor?.email === 'admin@demo-ngo.org',
      ),
    ).toBe(true);
  });
});
