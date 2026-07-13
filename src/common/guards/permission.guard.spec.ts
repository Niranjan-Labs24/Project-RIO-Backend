import { ForbiddenException } from '@nestjs/common';
import { orgContext } from '../../tenancy/org-context';
import { PermissionGuard, PERMISSION_KEY } from './permission.guard';

function guardWith(meta: { module: string; action: string } | undefined) {
  const reflector = { getAllAndOverride: (key: string) => (key === PERMISSION_KEY ? meta : undefined) } as never;
  const ctx = { getHandler: () => ({}), getClass: () => ({}) } as never;
  return { guard: new PermissionGuard(reflector), ctx };
}

describe('PermissionGuard', () => {
  it('allows routes with no @RequirePermission', () => {
    const { guard, ctx } = guardWith(undefined);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows when the caller role has the permission', () => {
    const { guard, ctx } = guardWith({ module: 'rolesPermissions', action: 'read' });
    const ok = orgContext.run({ requestId: 'r', orgId: 'o', role: 'system_admin' }, () => guard.canActivate(ctx));
    expect(ok).toBe(true);
  });

  it('forbids when the role lacks the permission', () => {
    const { guard, ctx } = guardWith({ module: 'rolesPermissions', action: 'read' });
    expect(() => orgContext.run({ requestId: 'r', orgId: 'o', role: 'field_researcher' }, () => guard.canActivate(ctx))).toThrow(ForbiddenException);
  });

  it('forbids when there is no role in context', () => {
    const { guard, ctx } = guardWith({ module: 'entityTeam', action: 'read' });
    expect(() => orgContext.run({ requestId: 'r' }, () => guard.canActivate(ctx))).toThrow(ForbiddenException);
  });
});
