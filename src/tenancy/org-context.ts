import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { DEFAULT_APP_LOCALE, type AppLocale } from '../i18n/locale';

export interface OrgStore {
  requestId: string;
  orgId?: string;
  actorId?: string;
  role?: string; // role key of the authenticated caller (populated by auth/dev seam)
  ip?: string; // client IP, captured by the middleware for audit rows
  userAgent?: string; // client UA, captured by the middleware for audit rows
  // RIO-RBAC-002 — set by PermissionGuard, mutating this same store object,
  // when a request only succeeded because of a PermissionGrant rather than
  // the static role matrix (never set for a request the static matrix
  // already allowed). AuditService.record() reads this to cite the grant
  // per the client's spec (Grant ID, approver, reason/scope, expiry).
  grantCitation?: { grantId: string; approvedBy: string; reason: string; expiresAt: string | null };
  /**
   * The language the caller is reading the application in, resolved from
   * `Accept-Language` by OrgContextMiddleware.
   *
   * Lives on the request store rather than being threaded through every service
   * signature because it is needed deep in code that has no other reason to
   * know about HTTP — the deterministic report narrative, for instance, is
   * composed four calls below the controller. Undefined for work with no
   * request behind it (bulk import, scheduled jobs); callers must fall back
   * rather than assume (RIO-I18N-003 §3.2).
   */
  locale?: AppLocale;
}

export const orgContext = new AsyncLocalStorage<OrgStore>();

export function getOrgStore(): OrgStore | undefined {
  return orgContext.getStore();
}

// Extends ForbiddenException (not Error) so the global AllExceptionsFilter's
// isEnvelope() check recognizes the standard error envelope and returns a
// clean 403, rather than an uncaught error falling through to a noisy 500.
export class MissingOrgContextError extends ForbiddenException {
  constructor() {
    super({ error: { code: 'NO_ORG_CONTEXT', message: 'No organisation context is set for this operation' } });
    this.name = 'MissingOrgContextError';
  }
}

export function requireOrgId(): string {
  const store = orgContext.getStore();
  if (!store?.orgId) {
    throw new MissingOrgContextError();
  }
  return store.orgId;
}

// For routes that require an authenticated caller but no specific module
// permission (me/logout/consent). Throws a clean 401 when no actor is set.
export function requireActor(): string {
  const store = orgContext.getStore();
  if (!store?.actorId) {
    throw new UnauthorizedException({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  }
  return store.actorId;
}


/**
 * The caller's locale, or English when there is no request behind this work.
 *
 * Deliberately a soft fallback rather than a throw: an unlocalised background
 * job must still produce a report, and English is the platform default. The
 * gap it papers over — background work having no locale of its own — is
 * closed properly by tiers 2 and 3 of RIO-I18N-003 §3.2
 * (`User.preferredLocale`, `Organisation.defaultLocale`), neither of which
 * exists yet.
 */
export function currentLocale(): AppLocale {
  return orgContext.getStore()?.locale ?? DEFAULT_APP_LOCALE;
}
