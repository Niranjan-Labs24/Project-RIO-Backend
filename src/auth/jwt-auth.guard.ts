import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLE_MATRIX } from '../rbac/role-matrix';
import { getOrgStore } from '../tenancy/org-context';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { PUBLIC_ROUTE_KEY } from './public.decorator';
import { SESSION_COOKIE_NAME } from './session-cookie';
import { TokenService } from './token.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
    private readonly tenant: TenantPrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { cookies?: Record<string, string> }>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) === true;
    const header = req.headers.authorization;
    const fromHeader = typeof header === 'string' && header.startsWith('Bearer ');
    const token = fromHeader ? header.slice('Bearer '.length) : req.cookies?.[SESSION_COOKIE_NAME];

    if (!token) {
      // Preserve the explicitly non-production header seam used by local and
      // integration tests. Production requests otherwise fail closed.
      if (isPublic || getOrgStore()?.role) return true;
      throw this.unauthenticated();
    }

    let claims;
    try {
      claims = this.tokens.verify(token);
    } catch {
      if (isPublic && !fromHeader) return true;
      throw new UnauthorizedException({
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' },
      });
    }

    // Claims identify a candidate session; current database state remains the
    // authority for tenant membership, organization state, and role.
    const current = await this.tenant.runAsSupervisor((tx) =>
      tx.user.findUnique({
        where: { id: claims.sub },
        select: { orgId: true, roleId: true, sessionVersion: true, org: { select: { isActive: true } } },
      }),
    );
    const currentRole = current ? ROLE_MATRIX.find((role) => role.id === current.roleId) : undefined;
    if (!current || !current.org.isActive || current.orgId !== claims.orgId ||
        current.sessionVersion !== claims.sessionVersion || !currentRole) {
      throw this.unauthenticated();
    }

    // RIO-NFR-006 load-test finding (2026-07-27, load-test/README.md):
    // sustained concurrent load reproduced write requests failing with a
    // 403 from PermissionGuard, root-caused as far as "the org-context role
    // is unset at that point" but never traced further — this silent
    // `if (store)` no-op is exactly the kind of failure mode that would
    // produce that symptom: if the AsyncLocalStorage context set by
    // OrgContextMiddleware is ever missing here (whatever the cause —
    // scheduling under load, a future refactor, etc.), the request
    // previously sailed through as authenticated-but-contextless, then
    // failed two guards later with a 403 that pointed nowhere near the
    // actual problem. Failing loudly and precisely here, at the exact
    // point of loss, is what turns "unresolved, needs request-level
    // tracing" into an actual stack trace the next time this reproduces.
    const store = getOrgStore();
    if (!store) {
      throw new UnauthorizedException({
        error: {
          code: 'ORG_CONTEXT_LOST',
          message: 'Request context was lost mid-request. Please retry.',
        },
      });
    }
    store.actorId = claims.sub;
    store.orgId = current.orgId;
    store.role = currentRole.key;
    return true;
  }

  private unauthenticated(): UnauthorizedException {
    return new UnauthorizedException({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  }
}
