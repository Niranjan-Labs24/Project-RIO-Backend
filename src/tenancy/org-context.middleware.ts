import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ConfigService } from '../config/config.service';
import { orgContext, type OrgStore } from './org-context';

@Injectable()
export class OrgContextMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = (req.headers['x-request-id'] as string) || uuidv4();
    // DEV-ONLY: real auth (later phase) derives orgId from the session/token.
    // Runtime-gated to non-production: in production the x-org-id header is
    // ignored entirely (orgId stays undefined), so requireOrgId() fails closed
    // until real auth is wired in a later phase. Never trust a client-supplied
    // org header in production.
    let orgId: string | undefined;
    if (this.config.nodeEnv !== 'production') {
      const orgHeader = req.headers['x-org-id'];
      orgId = typeof orgHeader === 'string' && orgHeader.length > 0 ? orgHeader : undefined;
    }
    const store: OrgStore = { requestId, orgId };
    res.setHeader('x-request-id', requestId);
    orgContext.run(store, () => next());
  }
}
