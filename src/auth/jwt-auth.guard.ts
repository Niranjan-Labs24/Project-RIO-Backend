import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { getOrgStore } from '../tenancy/org-context';
import { SESSION_COOKIE_NAME } from './session-cookie';
import { TokenService } from './token.service';

// Global guard (runs before PermissionGuard). Optional-populate: a valid bearer
// token or rio_session cookie overwrites the OrgStore (orgId/actorId/role) from
// verified claims; an absent token/cookie is non-blocking (the non-prod
// x-org-id/x-role dev seam remains the fallback populator, and prod fails
// closed via PermissionGuard). An invalid *Bearer header* is a hard 401; an
// invalid *cookie* is treated as anonymous (non-blocking) so a stale/expired
// cookie never breaks a public/anonymous request.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { cookies?: Record<string, string> }>();
    const header = req.headers['authorization'];

    let token: string | undefined;
    let fromHeader = false;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      token = header.slice('Bearer '.length);
      fromHeader = true;
    } else {
      token = req.cookies?.[SESSION_COOKIE_NAME];
    }

    if (!token) {
      return true; // no token → non-blocking
    }

    let claims;
    try {
      claims = this.tokens.verify(token);
    } catch {
      // A client that explicitly sent a Bearer header with a bad token gets a
      // hard 401. A stale/invalid cookie is treated as "not signed in" so
      // anonymous/public requests are not broken by an expired cookie.
      if (fromHeader) {
        throw new UnauthorizedException({
          error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' },
        });
      }
      return true;
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
