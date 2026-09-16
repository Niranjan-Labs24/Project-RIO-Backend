import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Client-confirmed (2026-08-27) — the signup Terms of Use / Data Sharing
 * Policy become versioned, app-managed content: "System Admin drafts, creates,
 * and updates policy versions", and "an approval gate is needed before a new
 * version goes live: System Admin drafts/initiates, System reviewer gives
 * final sign-off before it's published and shown at signup."
 *
 * The service unit suite pins the state machine; this pins the half that only
 * a real request can prove — that the two roles' actual permission grants
 * line up with the routes, so the reviewer genuinely cannot author policy text
 * and the admin genuinely cannot self-approve it.
 *
 * Requires a running, migrated, seeded DB (same as the other e2e specs).
 */
describe('Consent policy versioning workflow (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminToken: string;
  let reviewerToken: string;
  // Unique per run: version labels are permanent (a consent record may
  // reference one), so the workflow deliberately refuses to reuse a label —
  // a fixed 'v2' would pass once and 409 on every rerun.
  const label = `e2e-${Date.now()}`;
  let draftId: string;
  let citizenDraftId: string;
  let originalActiveCitizenId: string | null = null;
  // Captured before anything is published so afterAll can put the dev
  // database back: this spec really does change which Terms of Use every
  // signup screen renders, and leaving "E2E revised terms of use." live for
  // whoever opens the app next is not an acceptable test side effect.
  let originalActiveId: string | null = null;
  let prisma: PrismaService;

  // Bearer rather than the session cookie, same as the audit e2e: a
  // cookie-authenticated request also has to carry a matching x-csrf-token,
  // which is noise here — the subject under test is RBAC, not CSRF.
  async function login(email: string): Promise<string> {
    const res = await request(server)
      .post('/api/auth/login')
      .send({ email, password: 'Passw0rd!' })
      .expect(200);
    return res.body.token as string;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
    adminToken = await login('sysadmin@platform.local');
    reviewerToken = await login('sysreviewer@platform.local');
    const live = await prisma.consentPolicy.findFirst({
      where: { kind: 'use_policy', active: true },
      select: { id: true },
    });
    originalActiveId = live?.id ?? null;
    const liveCitizen = await prisma.consentPolicy.findFirst({
      where: { kind: 'citizen_consent', active: true },
      select: { id: true },
    });
    originalActiveCitizenId = liveCitizen?.id ?? null;
  });

  afterAll(async () => {
    // Straight to the table rather than through the API: publish() only moves
    // an *approved* version, so there is no supported route back to a version
    // that is already published — which is correct for production and exactly
    // why the restore has to happen here.
    if (originalActiveId) {
      await prisma.consentPolicy.updateMany({
        where: { kind: 'use_policy', active: true },
        data: { active: false },
      });
      await prisma.consentPolicy.update({
        where: { id: originalActiveId },
        data: { active: true },
      });
    }
    if (originalActiveCitizenId) {
      await prisma.consentPolicy.updateMany({
        where: { kind: 'citizen_consent', active: true },
        data: { active: false },
      });
      await prisma.consentPolicy.update({
        where: { id: originalActiveCitizenId },
        data: { active: true },
      });
    }
    // The version row itself is deliberately left behind: consent_policies
    // grants the app role INSERT/UPDATE but never DELETE, because a version
    // someone may have consented against must never disappear. Deactivated,
    // it is inert — just another superseded entry in the history list.
    await app.close();
  });

  it('lets a System Admin draft a new version, and does not put it live', async () => {
    const created = await request(server)
      .post('/api/consent-policy/versions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ kind: 'use_policy', version: label, text: 'E2E revised terms of use.' })
      .expect(201);

    expect(created.body).toMatchObject({ status: 'draft', active: false, version: label });
    draftId = created.body.id;

    // The signup screen is unmoved: a draft is invisible there by
    // construction, not by a filter someone has to remember.
    const live = await request(server).get('/api/consent-policy/active').expect(200);
    expect(live.body.usePolicy.version).not.toBe(label);
  });

  it('refuses a duplicate version label for the same kind', async () => {
    await request(server)
      .post('/api/consent-policy/versions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ kind: 'use_policy', version: label, text: 'Same label again.' })
      .expect(409)
      .expect((r) => expect(r.body.error.code).toBe('CONSENT_VERSION_EXISTS'));
  });

  it('forbids the System Reviewer from authoring policy text', async () => {
    // The Reviewer holds onboardingConsent:read + :approve, never :create or
    // :write — the client's split ("System Admin drafts... System reviewer
    // gives final sign-off"), enforced by the role matrix rather than by the
    // screen hiding a button.
    await request(server)
      .post('/api/consent-policy/versions')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ kind: 'use_policy', version: `${label}-reviewer`, text: 'Reviewer-authored.' })
      .expect(403);

    await request(server)
      .patch(`/api/consent-policy/versions/${draftId}`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ text: 'Reviewer-edited.' })
      .expect(403);
  });

  it('refuses to publish before a reviewer has signed off', async () => {
    await request(server)
      .post(`/api/consent-policy/versions/${draftId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409)
      .expect((r) => expect(r.body.error.code).toBe('CONSENT_POLICY_NOT_APPROVED'));
  });

  it('forbids the System Admin from approving its own draft', async () => {
    await request(server)
      .post(`/api/consent-policy/versions/${draftId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201)
      .expect((r) => expect(r.body.status).toBe('pending_approval'));

    await request(server)
      .patch(`/api/consent-policy/versions/${draftId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notes: 'Approving my own work.' })
      .expect(403);
  });

  it('requires reviewer notes on the sign-off', async () => {
    await request(server)
      .patch(`/api/consent-policy/versions/${draftId}/approve`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ notes: '   ' })
      .expect(400)
      .expect((r) => expect(r.body.error.code).toBe('REVIEWER_NOTES_REQUIRED'));
  });

  it('publishes after approval, and the signup endpoint serves the new version', async () => {
    const before = await request(server).get('/api/consent-policy/active').expect(200);
    const supersededVersion: string = before.body.usePolicy.version;

    await request(server)
      .patch(`/api/consent-policy/versions/${draftId}/approve`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ notes: 'PDPL review passed.' })
      .expect(200)
      .expect((r) => expect(r.body.status).toBe('approved'));

    await request(server)
      .post(`/api/consent-policy/versions/${draftId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201)
      .expect((r) => expect(r.body).toMatchObject({ status: 'published', active: true }));

    const after = await request(server).get('/api/consent-policy/active').expect(200);
    expect(after.body.usePolicy.version).toBe(label);
    expect(after.body.usePolicy.text).toBe('E2E revised terms of use.');

    // Client requirement 4 — the predecessor is retained, not rewritten:
    // still published, just no longer the active one, so acceptances filed
    // against it stay meaningful.
    const history = await request(server)
      .get('/api/consent-policy/versions')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const previous = (history.body.usePolicy as Array<Record<string, unknown>>).find(
      (v) => v.version === supersededVersion,
    );
    expect(previous).toMatchObject({ status: 'published', active: false });
  });

  it('refuses to edit a published version', async () => {
    await request(server)
      .patch(`/api/consent-policy/versions/${draftId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ text: 'Quietly rewritten after the fact.' })
      .expect(409)
      .expect((r) => expect(r.body.error.code).toBe('CONSENT_POLICY_PUBLISHED'));
  });

  // RIO-NFR-002 — the citizen notice moves through the identical gate. Its
  // own kind, so publishing it must not disturb either signup consent, and
  // the public citizen route must serve it without any session.
  it('manages the citizen consent notice through the same gate', async () => {
    const citizenLabel = `${label}-citizen`;
    const created = await request(server)
      .post('/api/consent-policy/versions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ kind: 'citizen_consent', version: citizenLabel, text: 'E2E citizen notice.' })
      .expect(201);
    citizenDraftId = created.body.id;

    // Reviewer still cannot author it.
    await request(server)
      .post('/api/consent-policy/versions')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ kind: 'citizen_consent', version: `${citizenLabel}-r`, text: 'Reviewer-authored.' })
      .expect(403);

    await request(server)
      .post(`/api/consent-policy/versions/${citizenDraftId}/submit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    // Admin still cannot sign off its own draft.
    await request(server)
      .patch(`/api/consent-policy/versions/${citizenDraftId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ notes: 'Self-approval.' })
      .expect(403);
    await request(server)
      .patch(`/api/consent-policy/versions/${citizenDraftId}/approve`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ notes: 'Privacy notice reviewed.' })
      .expect(200);
    await request(server)
      .post(`/api/consent-policy/versions/${citizenDraftId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    // Served on the public route, with no session at all.
    const live = await request(server).get('/api/consent-policy/citizen').expect(200);
    expect(live.body).toMatchObject({
      kind: 'citizen_consent',
      version: citizenLabel,
      text: 'E2E citizen notice.',
    });

    // And the signup payload is untouched — separate kinds, separate lifecycles.
    const signup = await request(server).get('/api/consent-policy/active').expect(200);
    expect(signup.body.usePolicy.version).not.toBe(citizenLabel);
    expect(signup.body).not.toHaveProperty('citizenConsent');
  });

  it('records the whole lifecycle in the audit log (client requirement 5)', async () => {
    const audit = await request(server)
      .get('/api/audit?entityType=consent_policy&limit=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const events = (audit.body.items ?? audit.body) as Array<{
      action: string;
      entityId: string;
      entityLabel: string;
    }>;
    const mine = events.filter((e) => e.entityId === draftId);
    expect(mine.length).toBeGreaterThanOrEqual(4);
    expect(mine.map((e) => e.entityLabel)).toContain(`Terms of Use ${label} published`);
    expect(mine.map((e) => e.entityLabel)).toContain(`Terms of Use ${label} approved`);
  });
});
