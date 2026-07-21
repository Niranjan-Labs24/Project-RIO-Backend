import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

// Requires a running, migrated DB. Unlike auth.e2e.spec.ts (bearer-token
// only), this flow is cookie-based, so the app must apply cookie-parser
// middleware the same way src/main.ts does — otherwise req.cookies is
// undefined and JwtAuthGuard can never see the rio_session cookie.
describe('signup -> me -> change-password (cookie)', () => {
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

  // A real SMTP send (see .env's SMTP_HOST) takes longer than the default
  // 5s test timeout — this only matters when testing against a live mail
  // provider; the mocked mailer.service.spec.ts covers the unconfigured/
  // failure paths quickly.
  it('signs up, sets rio_session cookie, resolves me, then changes password', async () => {
    const server = app.getHttpServer();
    const rn = `RN-${Date.now()}`;
    const email = `admin+${Date.now()}@e2e.test`;

    const signup = await request(server)
      .post('/api/auth/signup')
      .send({ organizationName: 'E2E NGO', purpose: 'testing', registrationNumber: rn, email })
      .expect(201);

    const cookie = signup.headers['set-cookie'];
    expect(cookie).toBeDefined();
    expect(Array.isArray(cookie)).toBe(true);
    expect((cookie as unknown as string[]).join(';')).toContain('rio_session=');
    expect(signup.body.mustChangePassword).toBe(true);
    expect(signup.body.organization.registrationNumber).toBe(rn);
    // Non-prod (NODE_ENV=test) with no SMTP configured -> temp password revealed.
    const tempPassword = signup.body.temporaryPassword as string;
    expect(typeof tempPassword).toBe('string');

    await request(server)
      .get('/api/auth/me')
      .set('Cookie', cookie as unknown as string[])
      .expect(200)
      .expect((r) => expect(r.body.user.email).toBe(email));

    await request(server)
      .post('/api/auth/change-password')
      .set('Cookie', cookie as unknown as string[])
      .send({ currentPassword: tempPassword, newPassword: 'BrandNewPass123!' })
      .expect(200)
      .expect((r) => expect(r.body.mustChangePassword).toBe(false));
  }, 20_000);
});
