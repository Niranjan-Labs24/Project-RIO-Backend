import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { getOrgStore } from '../tenancy/org-context';
import { TokenService } from './token.service';

// Global guard (runs before PermissionGuard). Optional-populate: a valid bearer
// token overwrites the OrgStore (orgId/actorId/role) from verified claims; an
// absent token is non-blocking (the non-prod x-org-id/x-role dev seam remains
// the fallback populator, and prod fails closed via PermissionGuard). An invalid
// token is a hard 401.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return true; // no token → non-blocking
    }
    const token = header.slice('Bearer '.length);
    let claims;
    try {
      claims = this.tokens.verify(token);
    } catch {
      throw new UnauthorizedException({
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' },
      });
    }
    const store = getOrgStore();
    if (store) {
      store.actorId = claims.sub;
      store.orgId = claims.orgId;
      store.role = claims.roleKey;
    }
    return true;
  }
}
