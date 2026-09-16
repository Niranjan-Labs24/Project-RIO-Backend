import { ForbiddenException } from '@nestjs/common';
import { orgContext, type OrgStore } from '../../tenancy/org-context';
import { PermissionGuard, PERMISSION_KEY } from './permission.guard';
import type { PermissionGrantsService } from '../../modules/permission-grants/permission-grants.service';

function guardWith(
  meta: { module: string; action: string } | undefined,
  grants: Pick<PermissionGrantsService, 'findActiveGrant'> = { findActiveGrant: async () => null },
) {
  const reflector = { getAllAndOverride: (key: string) => (key === PERMISSION_KEY ? meta : undefined) } as never;
  const ctx = { getHandler: () => ({}), getClass: () => ({}) } as never;
  return { guard: new PermissionGuard(reflector, grants as PermissionGrantsService), ctx };
}

describe('PermissionGuard', () => {
  it('allows routes with no @RequirePermission', async () => {
    const { guard, ctx } = guardWith(undefined);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows when the caller role has the permission', async () => {
    const { guard, ctx } = guardWith({ module: 'rolesPermissions', action: 'read' });
    const ok = await orgContext.run({ requestId: 'r', orgId: 'o', role: 'system_admin' }, () => guard.canActivate(ctx));
    expect(ok).toBe(true);
  });

  it('forbids when the role lacks the permission', async () => {
    const { guard, ctx } = guardWith({ module: 'rolesPermissions', action: 'read' });
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o', role: 'field_researcher' }, () => guard.canActivate(ctx)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('forbids when there is no role in context', async () => {
    const { guard, ctx } = guardWith({ module: 'entityTeam', action: 'read' });
    await expect(orgContext.run({ requestId: 'r' }, () => guard.canActivate(ctx))).rejects.toThrow(ForbiddenException);
  });

  // RIO-RBAC-002 — the runtime grant fallback, center_supervisor only.
  it('allows a center_supervisor whose static permission is denied, when an active grant covers it', async () => {
    const { guard, ctx } = guardWith(
      { module: 'studySurvey', action: 'write' },
      { findActiveGrant: async () => ({ grantId: 'g1', approvedBy: 'admin-1', reason: 'pilot fix', expiresAt: null }) },
    );
    const store: OrgStore = { requestId: 'r', orgId: 'o', actorId: 'sup-1', role: 'center_supervisor' };
    const ok = await orgContext.run(store, () => guard.canActivate(ctx));
    expect(ok).toBe(true);
    expect(store.grantCitation).toEqual({ grantId: 'g1', approvedBy: 'admin-1', reason: 'pilot fix', expiresAt: null });
  });

  it('forbids a center_supervisor with no matching active grant', async () => {
    const { guard, ctx } = guardWith({ module: 'studySurvey', action: 'write' });
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o', actorId: 'sup-1', role: 'center_supervisor' }, () => guard.canActivate(ctx)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('never checks grants for a role other than center_supervisor', async () => {
    let called = false;
    const { guard, ctx } = guardWith(
      { module: 'rolesPermissions', action: 'write' },
      { findActiveGrant: async () => { called = true; return { grantId: 'g1', approvedBy: 'a', reason: 'r', expiresAt: null }; } },
    );
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o', actorId: 'u1', role: 'field_researcher' }, () => guard.canActivate(ctx)),
    ).rejects.toThrow(ForbiddenException);
    expect(called).toBe(false);
  });
});
