import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLE_MATRIX } from '../rbac/role-matrix';
import { getOrgStore } from '../tenancy/org-context';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { PUBLIC_ROUTE_KEY } from './public.decorator';
import { SESSION_COOKIE_NAME } from './session-cookie';
import { TokenService } from './token.service';

// Header a crossEntity caller (System Admin) uses to act on behalf of a
// specific organisation for one request — e.g. creating a Study/Need/User
// under an org other than their own. Read here and nowhere else: this is
// the single place store.orgId is set, so gating it here means every
// existing org-scoped mechanism (RLS, geography-scope checks, audit
// records) picks it up automatically, with no changes needed in the
// individual services that call requireOrgId().
const ACT_AS_ORG_HEADER = 'x-act-as-org';

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

    const store = getOrgStore();
    if (store) {
      store.actorId = claims.sub;
      store.role = currentRole.key;
      store.orgId = current.orgId;

      // Only a crossEntity role may act on behalf of a different org, and
      // only when it actually sends the header — an ordinary tenant user
      // sending this header is silently ignored, never trusted.
      const actAsOrgId = req.headers[ACT_AS_ORG_HEADER];
      if (currentRole.crossEntity && typeof actAsOrgId === 'string' && actAsOrgId.length > 0) {
        const targetOrg = await this.tenant.runAsSupervisor((tx) =>
          tx.organisation.findUnique({ where: { id: actAsOrgId }, select: { isActive: true } }),
        );
        if (!targetOrg) {
          throw new ForbiddenException({
            error: { code: 'ACT_AS_ORG_NOT_FOUND', message: 'The selected organisation does not exist.' },
          });
        }
        if (!targetOrg.isActive) {
          throw new ForbiddenException({
            error: { code: 'ACT_AS_ORG_INACTIVE', message: 'The selected organisation is not active.' },
          });
        }
        store.orgId = actAsOrgId;
      }
    }
    return true;
  }

  private unauthenticated(): UnauthorizedException {
    return new UnauthorizedException({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  }
}
