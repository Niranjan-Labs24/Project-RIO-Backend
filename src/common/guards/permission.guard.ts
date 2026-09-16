import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getOrgStore } from '../../tenancy/org-context';
import { can, type PermissionAction, type PermissionModule } from '../../rbac/role-matrix';
import { AuditService } from '../../modules/audit/audit.service';
import { PermissionGrantsService } from '../../modules/permission-grants/permission-grants.service';

export const PERMISSION_KEY = 'requiredPermission';
export const RequirePermission = (module: PermissionModule, action: PermissionAction): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, { module, action });

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly grants: PermissionGrantsService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<{ module: PermissionModule; action: PermissionAction } | undefined>(
      PERMISSION_KEY, [context.getHandler(), context.getClass()],
    );
    if (!required) return true; // no permission constraint on this route

    const store = getOrgStore();
    if (can(store?.role, required.module, required.action)) return true;

    // RIO-RBAC-002 (client-confirmed 2026-08-23) — the static matrix said
    // no; center_supervisor is the only role this mechanism was built for
    // (PermissionGrantsService.create rejects any other grantee), so this
    // never widens what any other role can do. A hit here stamps the
    // request's own store with the authorizing grant id, mutating the same
    // object AsyncLocalStorage is already holding for this request, so
    // AuditService.record() downstream sees it without any extra plumbing.
    if (store?.role === 'center_supervisor' && store.actorId) {
      const grant = await this.grants.findActiveGrant(store.actorId, required.module, required.action);
      if (grant) {
        store.grantCitation = grant;
        return true;
      }
    }

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
      metadata: { module: required.module, action: required.action, role: store?.role ?? null },
    });
    throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Insufficient permission for this action' } });
  }
}
