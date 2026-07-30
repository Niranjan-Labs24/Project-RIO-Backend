import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

// Requires a running, migrated, seeded DB (admins: admin@demo-ngo.org = ngo_admin,
// sysadmin@platform.local = system_admin; password Passw0rd!) — same
// convention as organizations.e2e.spec.ts.
describe('NCNP Consolidated Report (e2e)', () => {
  let app: INestApplication;
  let sysToken: string; // system_admin (crossEntity)
  let adminToken: string; // ngo_admin (not crossEntity)

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
    sysToken = await login('sysadmin@platform.local');
    adminToken = await login('admin@demo-ngo.org');
  });
  afterAll(async () => {
    await app.close();
  });

  it('system_admin (crossEntity) reads the full report shape with real, non-empty totals', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/ncnp-report')
      .set('Authorization', `Bearer ${sysToken}`)
      .expect(200);

    expect(res.body.summary.totals.organizations).toBeGreaterThan(0);
    expect(res.body.summary.newThisPeriod.periodDays).toBe(30);
    expect(Array.isArray(res.body.needDomains)).toBe(true);
    // Every active domain is listed, even ones with 0 needs — this is the
    // real fix for the client's "under-represents the methodology" finding.
    expect(res.body.needDomains.length).toBeGreaterThanOrEqual(1);
    expect(res.body.studyStatus).toEqual(expect.objectContaining({ active: expect.any(Number), archived: expect.any(Number) }));
    expect(res.body.geography).toEqual(
      expect.objectContaining({
        organizationsByRegion: expect.any(Array),
        organizationsByGovernorate: expect.any(Array),
        organizationsByCenter: expect.any(Array),
        studiesByRegion: expect.any(Array),
      }),
    );
    expect(res.body.surveyAnalytics.statusPlatformWide).toEqual(
      expect.objectContaining({ draft: expect.any(Number), submitted: expect.any(Number), published: expect.any(Number), rejected: expect.any(Number) }),
    );
    expect(res.body.responseAnalytics).toEqual(
      expect.objectContaining({
        monthlyTrend: expect.any(Array),
        responsesByRegion: expect.any(Array),
        genderDistribution: expect.any(Array),
        topOrgsByTotalResponses: expect.any(Array),
        topOrgsByAvgResponsesPerSurvey: expect.any(Array),
      }),
    );
    expect(res.body.priorityOverview).toEqual(
      expect.objectContaining({ byStatus: expect.any(Array), domainComparison: expect.any(Array), topPriorityVillages: expect.any(Array) }),
    );
  });

  it('ngo_admin (not crossEntity) is forbidden from the platform-wide report', async () => {
    await request(app.getHttpServer())
      .get('/api/ncnp-report')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(403);
  });

  it('respects periodDays/dormantDays query overrides', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/ncnp-report?periodDays=7&dormantDays=14')
      .set('Authorization', `Bearer ${sysToken}`)
      .expect(200);

    expect(res.body.summary.newThisPeriod.periodDays).toBe(7);
    expect(res.body.orgHealth.dormantDays).toBe(14);
  });

  it('exports a real PDF (magic bytes, real Content-Type/Content-Disposition)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/ncnp-report/export?format=pdf')
      .set('Authorization', `Bearer ${sysToken}`)
      .expect(200);

    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="ncnp-compiled-report-\d{4}-\d{2}-\d{2}\.pdf"/);
    const body = res.body as Buffer;
    expect(body.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('exports a real Excel workbook (magic bytes, real Content-Type)', async () => {
    // superagent has no built-in binary parser for the xlsx mime type (unlike
    // application/pdf, which it recognizes automatically) — buffer the raw
    // response ourselves so res.body is the real Buffer, not `{}`.
    const res = await request(app.getHttpServer())
      .get('/api/ncnp-report/export?format=excel')
      .set('Authorization', `Bearer ${sysToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const body = res.body as Buffer;
    expect(body.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('rejects an unsupported export format', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/ncnp-report/export?format=csv')
      .set('Authorization', `Bearer ${sysToken}`)
      .expect(400);
    expect(res.body.error.code).toBe('EXPORT_FORMAT_NOT_SUPPORTED');
  });

  it('non-crossEntity role cannot export the report either', async () => {
    await request(app.getHttpServer())
      .get('/api/ncnp-report/export?format=pdf')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(403);
  });
});
