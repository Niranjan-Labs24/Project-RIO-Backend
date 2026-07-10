import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * STUB for the later auth phase (AD-6). It intentionally allows every request.
 * The real guard will read the authenticated session, enforce roles, and verify
 * org-scope at the DB layer. Do NOT rely on this for access control.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
