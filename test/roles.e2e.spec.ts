import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';

// Requires a running, migrated, seeded DB. Uses the dev x-org-id + x-role seam (non-prod).
describe('GET /api/roles (e2e)', () => {
  let app: INestApplication;
  const ORG = '00000000-0000-0000-0000-000000000001'; // any uuid; roles are global, not org-scoped

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter()); // mirror main.ts so DV-8 top-level message is emitted
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns all 9 roles to a system_admin', async () => {
    const res = await request(app.getHttpServer()).get('/api/roles').set('x-org-id', ORG).set('x-role', 'system_admin').expect(200);
    expect(res.body).toHaveLength(9);
    const admin = res.body.find((r: { key: string }) => r.key === 'ngo_admin');
    expect(admin.id).toBe('role_ngo_admin');
    expect(admin.permissions).toHaveLength(12);
  });

  it('forbids a role without rolesPermissions:read', async () => {
    const res = await request(app.getHttpServer()).get('/api/roles').set('x-org-id', ORG).set('x-role', 'field_researcher');
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Insufficient permission for this action'); // top-level message (DV-8)
  });
});
