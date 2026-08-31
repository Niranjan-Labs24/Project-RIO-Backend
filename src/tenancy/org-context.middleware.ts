import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ConfigService } from '../config/config.service';
import { localeFromAcceptLanguage } from '../i18n/locale';
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
    let role: string | undefined;
    if (this.config.nodeEnv !== 'production') {
      const orgHeader = req.headers['x-org-id'];
      orgId = typeof orgHeader === 'string' && orgHeader.length > 0 ? orgHeader : undefined;
      // DEV/TEST-ONLY seam (same non-prod gate as x-org-id): real auth populates
      // role from the session/token. Never trust a client-supplied role header
      // in production.
      const roleHeader = req.headers['x-role'];
      role = typeof roleHeader === 'string' && roleHeader.length > 0 ? roleHeader : undefined;
    }
    // Captured for audit rows (not a security seam) — trust the proxy's first
    // x-forwarded-for hop if present, else express's req.ip.
    const ip = req.ip || undefined;
    const ua = req.headers['user-agent'];
    const userAgent = typeof ua === 'string' ? ua : undefined;
    // The UI locale the caller is reading in. Unlike x-org-id/x-role above this
    // is NOT a security seam — it selects wording, never data — so it is read
    // in production too. The frontend sends its active locale segment; a client
    // that sends nothing falls back to English.
    const locale = localeFromAcceptLanguage(
      typeof req.headers['accept-language'] === 'string' ? req.headers['accept-language'] : undefined,
    );
    const store: OrgStore = { requestId, orgId, role, ip, userAgent, locale };
    res.setHeader('x-request-id', requestId);
    orgContext.run(store, () => next());
  }
}
