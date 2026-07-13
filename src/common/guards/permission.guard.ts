import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getOrgStore } from '../../tenancy/org-context';
import { can, type PermissionAction, type PermissionModule } from '../../rbac/role-matrix';

export const PERMISSION_KEY = 'requiredPermission';
export const RequirePermission = (module: PermissionModule, action: PermissionAction): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, { module, action });

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<{ module: PermissionModule; action: PermissionAction } | undefined>(
      PERMISSION_KEY, [context.getHandler(), context.getClass()],
    );
    if (!required) return true; // no permission constraint on this route
    const role = getOrgStore()?.role;
    if (!can(role, required.module, required.action)) {
      throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Insufficient permission for this action' } });
    }
    return true;
  }
}
