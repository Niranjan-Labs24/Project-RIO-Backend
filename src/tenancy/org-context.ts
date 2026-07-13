import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

export interface OrgStore {
  requestId: string;
  orgId?: string;
  actorId?: string;
  role?: string; // role key of the authenticated caller (populated by auth/dev seam)
  ip?: string; // client IP, captured by the middleware for audit rows
  userAgent?: string; // client UA, captured by the middleware for audit rows
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
