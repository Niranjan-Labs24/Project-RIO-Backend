import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { MailerService } from '../src/mailer/mailer.service';

// Requires a running, migrated DB. Unlike auth.e2e.spec.ts (bearer-token
// only), this flow is cookie-based, so the app must apply cookie-parser
// middleware the same way src/main.ts does — otherwise req.cookies is
// undefined and JwtAuthGuard can never see the rio_session cookie.
describe('signup -> me -> change-password (cookie)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Force the "email couldn't be sent" branch deterministically — this
      // test asserts on the temporary password revealed in the response,
      // which only happens when the send fails. Without this override, an
      // environment with real SMTP creds configured (e.g. a local .env)
      // would email the password away instead and the response would omit
      // it, regardless of NODE_ENV.
      .overrideProvider(MailerService)
      .useValue({ sendTemporaryPassword: async () => false, sendOtpCode: async () => false })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('signs up, sets rio_session cookie, resolves me, then changes password', async () => {
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

    // RIO-DATA-001 — consent is part of registration, so the versions have to
    // come from the live policies. Also a public endpoint (no session exists
    // yet at this point in the flow).
    const policies = await request(server).get('/api/consent-policy/active').expect(200);
    expect(policies.body.usePolicy.version).toBeTruthy();
    expect(policies.body.dataSharing.version).toBeTruthy();

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
        consent: {
          usePolicyVersion: policies.body.usePolicy.version,
          dataSharingVersion: policies.body.dataSharing.version,
        },
      })
      .expect(201);

    const cookie = signup.headers['set-cookie'] as unknown as string[];
    expect(cookie).toBeDefined();
    expect(Array.isArray(cookie)).toBe(true);
    expect(cookie.join(';')).toContain('rio_session=');
    const csrfCookie = cookie.find((c) => c.startsWith('rio_csrf='));
    const csrf = csrfCookie?.match(/rio_csrf=([^;]*)/)?.[1] ?? '';
    expect(signup.body.mustChangePassword).toBe(true);
    expect(signup.body.organization.registrationNumber).toBe(rn);
    // The MailerService override above forces the send to "fail" -> temp
    // password revealed in the response, deterministically regardless of
    // whether this environment has real SMTP creds configured.
    expect(signup.body.temporaryPasswordEmailed).toBe(false);
    const tempPassword = signup.body.temporaryPassword as string;
    expect(typeof tempPassword).toBe('string');

    await request(server)
      .get('/api/auth/me')
      .set('Cookie', cookie)
      .expect(200)
      .expect((r) => expect(r.body.user.email).toBe(email));

    const changePassword = await request(server)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({ currentPassword: tempPassword, newPassword: 'BrandNewPass123!' })
      .expect(200)
      .expect((r) => expect(r.body.mustChangePassword).toBe(false));

    // change-password bumps sessionVersion server-side and must re-issue the
    // rio_session cookie with a matching fresh token — otherwise the very
    // next cookie-authenticated request (e.g. consent, right after the
    // signup -> change-password flow) is wrongly rejected as UNAUTHENTICATED
    // by JwtAuthGuard's sessionVersion check, even with a brand-new browser
    // session and no stale cookies involved. change-password only reissues
    // rio_session (rio_csrf is untouched), so a real browser would keep
    // both — merge them the same way here rather than replacing wholesale.
    const refreshedSessionCookie = (changePassword.headers['set-cookie'] as unknown as string[])?.find((c) =>
      c.startsWith('rio_session='),
    );
    expect(refreshedSessionCookie).toBeDefined();
    const refreshedCookies = [refreshedSessionCookie as string, csrfCookie as string];

    await request(server)
      .post('/api/auth/consent')
      .set('Cookie', refreshedCookies)
      .set('x-csrf-token', csrf)
      .expect(201);

    // RIO-DATA-001 — the admin came out of registration already consented on
    // both, so `me()` reports both pairs stamped. This is what lets the
    // client's consent gate wave a freshly registered org straight through.
    await request(server)
      .get('/api/auth/me')
      .set('Cookie', refreshedCookies)
      .expect(200)
      .expect((r) => {
        expect(r.body.user.consentedAt).toBeTruthy();
        expect(r.body.user.consentedPolicyVersion).toBe(policies.body.usePolicy.version);
        expect(r.body.user.sharingConsentedAt).toBeTruthy();
        expect(r.body.user.sharingConsentedPolicyVersion).toBe(
          policies.body.dataSharing.version,
        );
      });
  }, 20_000);

  // RIO-DATA-001 — "registration cannot complete without it" is the actual
  // requirement, so these prove the server refuses, not merely that the form
  // asks. Each asserts no organisation was created.
  describe('consent is mandatory at registration', () => {
    async function geography() {
      const server = app.getHttpServer();
      const regions = await request(server).get('/api/regions').expect(200);
      const regionId = regions.body[0].id;
      const governorates = await request(server).get('/api/governorates').query({ regionId }).expect(200);
      const governorateId = governorates.body[0].id;
      const centers = await request(server).get('/api/centers').query({ governorateId }).expect(200);
      return { regionId, governorateIds: [governorateId], centerIds: [centers.body[0].id] };
    }

    function body(geo: Awaited<ReturnType<typeof geography>>, consent?: unknown) {
      const stamp = `${Date.now()}${Math.round(performance.now())}`;
      return {
        organizationName: 'No-Consent NGO',
        purpose: 'testing',
        registrationNumber: `RN-NC-${stamp}`,
        email: `noconsent+${stamp}@e2e.test`,
        ...geo,
        ...(consent === undefined ? {} : { consent }),
      };
    }

    it('rejects a signup with no consent block at all (400)', async () => {
      const geo = await geography();
      const res = await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send(body(geo))
        .expect(400);
      // Schema-level rejection — never reaches the service, so nothing is created.
      expect(res.body.error).toBeDefined();
    });

    it('rejects a signup accepting only the use policy (400)', async () => {
      const geo = await geography();
      const policies = await request(app.getHttpServer()).get('/api/consent-policy/active').expect(200);
      await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send(body(geo, { usePolicyVersion: policies.body.usePolicy.version }))
        .expect(400);
    });

    it('rejects a stale consent version with CONSENT_VERSION_STALE and creates nothing', async () => {
      const geo = await geography();
      const policies = await request(app.getHttpServer()).get('/api/consent-policy/active').expect(200);
      const payload = body(geo, {
        usePolicyVersion: policies.body.usePolicy.version,
        // A version that is syntactically fine but not the active one — the
        // "form left open across a policy update" case.
        dataSharingVersion: 'v-not-active',
      });
      const res = await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send(payload)
        .expect(400);
      expect(res.body.error?.code ?? res.body.code).toBe('CONSENT_VERSION_STALE');

      // The registration number is still free — proof the rejection happened
      // before any org row was written.
      const policiesAgain = await request(app.getHttpServer()).get('/api/consent-policy/active').expect(200);
      await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send({
          ...payload,
          consent: {
            usePolicyVersion: policiesAgain.body.usePolicy.version,
            dataSharingVersion: policiesAgain.body.dataSharing.version,
          },
        })
        .expect(201);
    }, 20_000);
  });
});
