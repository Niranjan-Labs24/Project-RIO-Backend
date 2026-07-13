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
    expect(Array.isArray(res.body)).toBe(true);
    const loginEvent = res.body.find((e: { action: string }) => e.action === 'login');
    expect(loginEvent).toBeDefined();
    expect(loginEvent.entityType).toBe('user');
    expect(loginEvent.actor?.email).toBe('admin@demo-ngo.org');
  });

  it('traces a specific entity: filter by entityType + entityId (NFR-004)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/audit?entityType=user&entityId=${adminUserId}&limit=100`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((e: { entityType: string; entityId: string }) => e.entityType === 'user' && e.entityId === adminUserId)).toBe(true);
  });

  it('bounds the result set with limit (NFR-006 pagination)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/audit?limit=1')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.length).toBeLessThanOrEqual(1);
  });
});
