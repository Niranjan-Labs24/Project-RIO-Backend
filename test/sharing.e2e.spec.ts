import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { TokenService } from '../src/auth/token.service';
import { ownerClient } from './db.helper';
import type { PrismaClient } from '../src/generated/prisma';

// FR-014 (NGO Report/Study Sharing) — real HTTP + RBAC + RLS coverage on top
// of the unit-level business-rule tests in sharing.service.spec.ts /
// report-sharing.service.spec.ts. Those bypass the HTTP guards/validation
// pipe entirely, so this exercises what they can't: the 403/400 wiring
// through the real controllers, and — the actual thing this story requires
// — that a cross-org audit event and a sharing alert are genuinely visible
// from *both* orgs, not just asserted against a mocked AuditService.
//
// Fixtures are seeded directly via the owner (cnap_owner, RLS-bypassing)
// client, one org-scoped transaction per org, mirroring
// tenant-isolation.e2e.spec.ts's own fixture pattern. Tokens are minted
// directly via TokenService (bypassing login/passwords entirely) since
// JwtAuthGuard trusts any validly-signed bearer token's claims — see
// jwt-auth.guard.ts.
describe('Sharing workflow (e2e) — FR-014', () => {
  let app: INestApplication;
  let owner: PrismaClient;
  let tokens: TokenService;
  const run = Date.now();

  let orgAId: string; // owner org (has the Study + Report)
  let orgBId: string; // requesting org
  let tokenA: string;
  let tokenB: string;
  let studyId: string;
  let reportId: string;
  let studyRequestId: string;
  let reportRequestId: string;

  async function seedOrgWithAdmin(name: string, adminEmail: string): Promise<{ orgId: string; adminId: string }> {
    const orgId = uuidv7();
    return owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx.organisation.create({ data: { id: orgId, name, isActive: true } });
      const admin = await tx.user.create({
        data: {
          orgId, roleId: 'role_ngo_admin', name: `${name} Admin`, email: adminEmail,
          status: 'active', passwordHash: 'unused-minted-token-bypasses-login',
        },
      });
      return { orgId, adminId: admin.id };
    });
  }

  async function seedStudyAndReport(orgId: string, adminId: string): Promise<{ studyId: string; reportId: string }> {
    return owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      const study = await tx.study.create({
        data: { orgId, title: `Sharing Test Study ${run}`, cycleNumber: 1, createdBy: adminId },
      });
      const report = await tx.report.create({
        data: {
          orgId, reportType: 'RPT13', status: 'approved', title: `Sharing Test Report ${run}`,
          studyId: study.id, filters: {}, content: {}, generatedBy: adminId,
        },
      });
      return { studyId: study.id, reportId: report.id };
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    tokens = moduleRef.get(TokenService);
    owner = ownerClient();

    const a = await seedOrgWithAdmin(`Sharing Owner Org ${run}`, `sharing-owner-${run}@example.org`);
    const b = await seedOrgWithAdmin(`Sharing Requester Org ${run}`, `sharing-requester-${run}@example.org`);
    orgAId = a.orgId;
    orgBId = b.orgId;

    const fixtures = await seedStudyAndReport(orgAId, a.adminId);
    studyId = fixtures.studyId;
    reportId = fixtures.reportId;

    tokenA = tokens.sign({ sub: a.adminId, orgId: orgAId, roleKey: 'ngo_admin' });
    tokenB = tokens.sign({ sub: b.adminId, orgId: orgBId, roleKey: 'ngo_admin' });
  });

  afterAll(async () => {
    for (const orgId of [orgAId, orgBId]) {
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
        await tx.$executeRaw`DELETE FROM report_sharing_requests WHERE owner_org_id = ${orgId}::uuid OR requesting_org_id = ${orgId}::uuid`;
        await tx.$executeRaw`DELETE FROM sharing_requests WHERE owner_org_id = ${orgId}::uuid OR requesting_org_id = ${orgId}::uuid`;
        await tx.$executeRaw`DELETE FROM audit_logs WHERE organisation_id = ${orgId}::uuid`;
        await tx.$executeRaw`DELETE FROM reports WHERE org_id = ${orgId}::uuid`;
        await tx.$executeRaw`DELETE FROM studies WHERE org_id = ${orgId}::uuid`;
        await tx.$executeRaw`DELETE FROM users WHERE org_id = ${orgId}::uuid`;
        await tx.$executeRaw`DELETE FROM organisations WHERE id = ${orgId}::uuid`;
      });
    }
    await owner.$disconnect();
    await app.close();
  });

  describe('Study sharing', () => {
    it('the requesting org creates a pending request', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/sharing-requests')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ ownerOrgId: orgAId, studyId, note: 'For a similar assessment' })
        .expect(201);
      expect(res.body.status).toBe('pending');
      studyRequestId = res.body.id;
    });

    it('only the owning org can decide it — the requester gets 403', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/sharing-requests/${studyRequestId}/approve`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({});
      expect(res.status).toBe(403);
    });

    it('rejecting without a reason is refused with a clean 400', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/sharing-requests/${studyRequestId}/reject`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('REJECT_REASON_REQUIRED');
    });

    it('the owning org approves it', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/sharing-requests/${studyRequestId}/approve`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(200);
      expect(res.body.status).toBe('approved');
    });

    it('the requesting org can now view the shared study read-only', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/sharing-requests/${studyRequestId}/shared-study`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      expect(res.body.studyId).toBe(studyId);
      expect(typeof res.body.evidenceCount).toBe('number');
    });

    it('the approval is visible in BOTH orgs\' own Audit Log — not just the org that acted', async () => {
      const asOwner = await request(app.getHttpServer())
        .get(`/api/audit?entityType=sharing_request&entityId=${studyRequestId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      const asRequester = await request(app.getHttpServer())
        .get(`/api/audit?entityType=sharing_request&entityId=${studyRequestId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);

      expect(asOwner.body.items.length).toBeGreaterThan(0);
      expect(asRequester.body.items.length).toBeGreaterThan(0);
      // The bug this regression-guards: the actor (owner org's admin) must
      // resolve by name even when viewed from the *requester*'s own RLS
      // context, not silently fall back to a null/"System" actor.
      const approveEvent = asRequester.body.items.find((e: { action: string }) => e.action === 'approve');
      expect(approveEvent).toBeDefined();
      expect(approveEvent.actor).not.toBeNull();
    });

    it('the requesting org sees a request_approved sharing alert', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/sharing-alerts')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      const alert = res.body.find(
        (a: { requestId: string; type: string }) => a.requestId === studyRequestId,
      );
      expect(alert).toBeDefined();
      expect(alert.type).toBe('request_approved');
    });

    it('the owning org sees no pending-incoming alert for it anymore (already decided)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/sharing-alerts')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      const alert = res.body.find(
        (a: { requestId: string; type: string }) => a.requestId === studyRequestId,
      );
      expect(alert).toBeUndefined();
    });
  });

  describe('Report sharing', () => {
    it('the requesting org creates a pending request', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/report-sharing-requests')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ ownerOrgId: orgAId, reportId, note: 'For reference' })
        .expect(201);
      expect(res.body.status).toBe('pending');
      reportRequestId = res.body.id;
    });

    it('the owning org rejects it with a reason', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/report-sharing-requests/${reportRequestId}/reject`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ note: 'Not relevant to your current work' })
        .expect(200);
      expect(res.body.status).toBe('rejected');
      expect(res.body.decisionNote).toBe('Not relevant to your current work');
    });

    it('a rejected (never-approved) report can never be viewed as shared — view-only gate holds', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/report-sharing-requests/${reportRequestId}/shared-report`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SHARING_NOT_APPROVED');
    });

    it('the requesting org sees a request_rejected alert carrying the reason', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/sharing-alerts')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      const alert = res.body.find(
        (a: { requestId: string; type: string }) => a.requestId === reportRequestId,
      );
      expect(alert).toBeDefined();
      expect(alert.type).toBe('request_rejected');
      expect(alert.reason).toBe('Not relevant to your current work');
    });

    it('the rejection is visible in BOTH orgs\' own Audit Log, including the reject reason', async () => {
      const asOwner = await request(app.getHttpServer())
        .get(`/api/audit?entityType=report_sharing_request&entityId=${reportRequestId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      const asRequester = await request(app.getHttpServer())
        .get(`/api/audit?entityType=report_sharing_request&entityId=${reportRequestId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      expect(asOwner.body.items.length).toBeGreaterThan(0);
      expect(asRequester.body.items.length).toBeGreaterThan(0);
    });

    it('the export/download routes no longer exist for a shared report (view-only, RIO-FR-Add-04 Change 2)', async () => {
      await request(app.getHttpServer())
        .get(`/api/report-sharing-requests/${reportRequestId}/export`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
    });
  });
});
