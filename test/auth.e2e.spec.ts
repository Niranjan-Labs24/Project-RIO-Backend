import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

// Requires a running, migrated, seeded DB (dev password Passw0rd! on the admins).
describe('Auth (e2e)', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('logs in with valid credentials and returns a SessionContext', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@demo-ngo.org', password: 'Passw0rd!' })
      .expect(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user.email).toBe('admin@demo-ngo.org');
    expect(res.body.organization.name).toBe('Demo NGO');
    expect(res.body.role.key).toBe('ngo_admin');
    expect(res.body.role.permissions).toHaveLength(12);
    token = res.body.token;
  });

  it('returns the session for GET /api/auth/me with a bearer token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.user.email).toBe('admin@demo-ngo.org');
  });

  it('401s GET /api/auth/me without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(typeof res.body.message).toBe('string');
  });

  it('logs out (204) with a token', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
  });

  it('rejects a wrong password with 401 + top-level message', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@demo-ngo.org', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
  });
});
