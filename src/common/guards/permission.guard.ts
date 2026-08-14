import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getOrgStore } from '../../tenancy/org-context';
import { can, type PermissionAction, type PermissionModule } from '../../rbac/role-matrix';
import { AuditService } from '../../modules/audit/audit.service';

export const PERMISSION_KEY = 'requiredPermission';
export const RequirePermission = (module: PermissionModule, action: PermissionAction): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, { module, action });

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly audit?: AuditService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<{ module: PermissionModule; action: PermissionAction } | undefined>(
      PERMISSION_KEY, [context.getHandler(), context.getClass()],
    );
    if (!required) return true; // no permission constraint on this route
    const role = getOrgStore()?.role;
    if (!can(role, required.module, required.action)) {
      // Fire-and-forget: audit failures must never block or swallow the 403.
      // AuditService.record() has its own try/catch so this void call is safe.
      // Route extraction is best-effort: non-HTTP contexts (WebSocket, RPC) and
      // unit-test mocks that don't implement getType() both fall back to null.
      let route: string | null = null;
      try {
        if (context.getType() === 'http') {
          route = context.switchToHttp().getRequest<{ url?: string }>().url ?? null;
        }
      } catch { /* non-HTTP or incomplete context — leave route as null */ }
      void this.audit?.record({
        action: 'ACCESS_DENIED',
        entityType: 'permission',
        entityId: null,
        entityLabel: `${required.module}:${required.action}`,
        sourceRef: route,
        metadata: { module: required.module, action: required.action, role: role ?? null },
      });
      throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Insufficient permission for this action' } });
    }
    return true;
  }
}
