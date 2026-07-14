import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '../../config/config.service';
import { CSRF_COOKIE_NAME } from '../../auth/session-cookie';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Opt-in double-submit CSRF. Off by default (CSRF_ENFORCE=false) so it does not
// break the frontend until the frontend echoes the rio_csrf cookie as the
// X-CSRF-Token header. Turn on only for cross-site (sameSite=none) deployments.
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.csrfEnforce) return true;
    const req = context.switchToHttp().getRequest<Request & { cookies?: Record<string, string> }>();
    if (SAFE_METHODS.has(req.method)) return true;

    const cookie = req.cookies?.[CSRF_COOKIE_NAME];
    const header = req.headers['x-csrf-token'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    if (!cookie || !headerValue || cookie !== headerValue) {
      throw new ForbiddenException({ error: { code: 'CSRF_TOKEN_INVALID', message: 'Missing or invalid CSRF token' } });
    }
    return true;
  }
}
