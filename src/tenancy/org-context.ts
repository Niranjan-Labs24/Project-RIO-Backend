import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenException } from '@nestjs/common';

export interface OrgStore {
  requestId: string;
  orgId?: string;
  actorId?: string;
  role?: string; // role key of the authenticated caller (populated by auth/dev seam)
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
