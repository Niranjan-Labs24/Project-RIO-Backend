import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getOrgStore } from '../../tenancy/org-context';
import { can, type PermissionAction, type PermissionModule } from '../../rbac/role-matrix';
import { PermissionGrantsService } from '../../modules/permission-grants/permission-grants.service';

export const PERMISSION_KEY = 'requiredPermission';
export const RequirePermission = (module: PermissionModule, action: PermissionAction): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, { module, action });

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly grants: PermissionGrantsService,
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
      const grant = await this.grants.findActiveGrant(store.actorId, required.module, required.action, store.orgId);
      if (grant) {
        store.grantCitation = grant;
        return true;
      }
    }

    throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Insufficient permission for this action' } });
  }
}
