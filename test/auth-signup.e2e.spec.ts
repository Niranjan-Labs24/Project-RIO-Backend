import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { DEFAULT_TEMP_PASSWORD } from '../src/modules/auth/auth.repository';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';

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

  // Signup now only accepts a registration number that is a NIC number in the
  // `nic_registry` reference table (see NicRegistryService), so the old
  // `RN-${Date.now()}` placeholders no longer get past the gate. Each run has
  // to claim a *real* number that no org has taken yet — the registry holds
  // ~7.8k of them and every successful signup consumes one, so this picks the
  // first free one rather than a fixed fixture that would 409 on the second
  // run. Read through the supervisor client: `organisations` is RLS-protected
  // and there is no session at this point in the flow.
  async function takeUnusedNicNumber(): Promise<string> {
    const tenant = app.get(TenantPrismaService);
    const nicNumber = await tenant.runAsSupervisor(async (tx) => {
      const used = await tx.organisation.findMany({
        where: { registrationNumber: { not: null } },
        select: { registrationNumber: true },
      });
      const taken = used
        .map((o) => o.registrationNumber)
        .filter((n): n is string => n !== null);
      const row = await tx.nicRegistry.findFirst({
        where: taken.length > 0 ? { nicNumber: { notIn: taken } } : undefined,
        orderBy: { nicNumber: 'asc' },
        select: { nicNumber: true },
      });
      return row?.nicNumber ?? null;
    });
    if (!nicNumber) {
      throw new Error('No unused NIC number available — run `pnpm import:nic-registry` first.');
    }
    return nicNumber;
  }

  it('blocks login until approved, then lets the entity log in with the temp password System Admin\'s approval issues', async () => {
    const server = app.getHttpServer();
    const rn = await takeUnusedNicNumber();
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

    // No session is established at signup — pending approval, nothing else.
    expect(signup.body).toEqual({ status: 'pending_approval', organizationName: 'E2E NGO', email });
    expect(signup.headers['set-cookie']).toBeUndefined();

    // Login is blocked until approved — org.isActive is false from creation.
    await request(server)
      .post('/api/auth/login')
      .send({ email, password: DEFAULT_TEMP_PASSWORD })
      .expect(403)
      .expect((r) => expect(r.body.error.code).toBe('ORG_INACTIVE'));

    // System Reviewer logs in and approves the pending entity — org approval
    // is a governance sign-off (entityTeam:approve), held by System Reviewer,
    // not System Admin's edit authority (entityTeam:write). See
    // organizations.controller.ts's `:id/approve` guard.
    const adminLogin = await request(server)
      .post('/api/auth/login')
      .send({ email: 'sysreviewer@platform.local', password: 'Passw0rd!' })
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

    // RIO-DATA-001 — consent is recorded at signup itself now (no separate
    // POST /auth/consent step for a self-registered admin), so `me()` should
    // already report both pairs stamped from registration, not just after
    // some later re-consent action.
    const entityCookies = entityLogin.headers['set-cookie'] as unknown as string[];
    await request(server)
      .get('/api/auth/me')
      .set('Cookie', entityCookies)
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
  // The signup form's Verify button. Public and rate-limited, and answers
  // with a verdict only — no entity data — so it can't be used to read the
  // register.
  describe('POST /auth/verify-registration-number', () => {
    it('verifies a number that is in the registry', async () => {
      const nicNumber = await takeUnusedNicNumber();
      const res = await request(app.getHttpServer())
        .post('/api/auth/verify-registration-number')
        .send({ registrationNumber: nicNumber })
        .expect(200);
      expect(res.body).toEqual({ verified: true });
    });

    it('accepts the same number typed with separators', async () => {
      const nicNumber = await takeUnusedNicNumber();
      const spaced = `${nicNumber.slice(0, 4)}-${nicNumber.slice(4, 7)}-${nicNumber.slice(7)}`;
      const res = await request(app.getHttpServer())
        .post('/api/auth/verify-registration-number')
        .send({ registrationNumber: spaced })
        .expect(200);
      expect(res.body).toEqual({ verified: true });
    });

    it('answers 200 with a reason — not an error — for a number it does not hold', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/verify-registration-number')
        .send({ registrationNumber: '0000000000' })
        .expect(200);
      expect(res.body).toEqual({ verified: false, reason: 'NOT_FOUND' });
    });

    it('distinguishes a malformed number from an unknown one', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/verify-registration-number')
        .send({ registrationNumber: 'NGO123456' })
        .expect(200);
      expect(res.body).toEqual({ verified: false, reason: 'INVALID_FORMAT' });
    });

    it('does not verify a registration number into existence — signup still checks', async () => {
      // The endpoint is convenience, not authorization: a verdict here grants
      // nothing, and signup re-runs the same check server-side.
      const geo = await (async () => {
        const server = app.getHttpServer();
        const regions = await request(server).get('/api/regions').expect(200);
        const regionId = regions.body[0].id;
        const governorates = await request(server).get('/api/governorates').query({ regionId }).expect(200);
        const governorateId = governorates.body[0].id;
        const centers = await request(server).get('/api/centers').query({ governorateId }).expect(200);
        return { regionId, governorateIds: [governorateId], centerIds: [centers.body[0].id] };
      })();
      const policies = await request(app.getHttpServer()).get('/api/consent-policy/active').expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send({
          organizationName: 'Unverified NGO',
          purpose: 'testing',
          registrationNumber: '0000000000',
          email: `unverified+${Date.now()}@e2e.test`,
          ...geo,
          consent: {
            usePolicyVersion: policies.body.usePolicy.version,
            dataSharingVersion: policies.body.dataSharing.version,
          },
        })
        .expect(400);
      expect(res.body.error?.code ?? res.body.code).toBe('REGISTRATION_NUMBER_NOT_RECOGNISED');
    });
  });

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

    // `registrationNumber` is passed in rather than stamped: it has to be a
    // real, unclaimed NIC number now, and the stale-consent test below reuses
    // the same one across its two requests on purpose.
    function body(
      geo: Awaited<ReturnType<typeof geography>>,
      registrationNumber: string,
      consent?: unknown,
    ) {
      const stamp = `${Date.now()}${Math.round(performance.now())}`;
      return {
        organizationName: 'No-Consent NGO',
        purpose: 'testing',
        registrationNumber,
        email: `noconsent+${stamp}@e2e.test`,
        ...geo,
        ...(consent === undefined ? {} : { consent }),
      };
    }

    it('rejects a signup with no consent block at all (400)', async () => {
      const geo = await geography();
      const res = await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send(body(geo, await takeUnusedNicNumber()))
        .expect(400);
      // Schema-level rejection — never reaches the service, so nothing is created.
      expect(res.body.error).toBeDefined();
    });

    it('rejects a signup accepting only the use policy (400)', async () => {
      const geo = await geography();
      const policies = await request(app.getHttpServer()).get('/api/consent-policy/active').expect(200);
      await request(app.getHttpServer())
        .post('/api/auth/signup')
        .send(body(geo, await takeUnusedNicNumber(), { usePolicyVersion: policies.body.usePolicy.version }))
        .expect(400);
    });

    it('rejects a stale consent version with CONSENT_VERSION_STALE and creates nothing', async () => {
      const geo = await geography();
      const policies = await request(app.getHttpServer()).get('/api/consent-policy/active').expect(200);
      const payload = body(geo, await takeUnusedNicNumber(), {
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
