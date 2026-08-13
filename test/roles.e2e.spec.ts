import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { ROLE_MATRIX, PERMISSION_MODULES } from '../src/rbac/role-matrix';

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

  it('returns every seeded role to a system_admin', async () => {
    const res = await request(app.getHttpServer()).get('/api/roles').set('x-org-id', ORG).set('x-role', 'system_admin').expect(200);
    // Derived from ROLE_MATRIX/PERMISSION_MODULES rather than hardcoded —
    // adding a role or module later shouldn't break this test.
    expect(res.body).toHaveLength(ROLE_MATRIX.length);
    const admin = res.body.find((r: { key: string }) => r.key === 'ngo_admin');
    expect(admin.id).toBe('role_ngo_admin');
    expect(admin.permissions).toHaveLength(PERMISSION_MODULES.length);
  });

  // Bug fix (Aug 13): this endpoint used to require rolesPermissions:read —
  // the Roles & Permissions *admin* page's own concern, still separately
  // protected on the frontend route. Most roles hold no rolesPermissions
  // grant at all per the confirmed matrix (field_researcher included), which
  // meant the Users page's "assignable roles" dropdown 403'd for them and
  // silently hid the Create User button. Fixed to entityTeam:read — every
  // login-capable role holds that (basic team-visibility), so this now
  // succeeds for a role like field_researcher that has no rolesPermissions
  // access at all, proving the fix actually unblocks it.
  it('succeeds for a role with entityTeam:read but no rolesPermissions:read (the fixed bug)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/roles')
      .set('x-org-id', ORG)
      .set('x-role', 'field_researcher')
      .expect(200);
    expect(res.body).toHaveLength(ROLE_MATRIX.length);
  });
});
