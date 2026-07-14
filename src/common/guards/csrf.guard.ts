import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ConfigService } from '../../config/config.service';
import { CSRF_COOKIE_NAME } from '../../auth/session-cookie';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Routes that ISSUE the rio_csrf cookie (login/signup) establish a session
// rather than consuming one — no cookie exists yet on that first request, so
// they must be exempt from the double-submit check or enabling CSRF_ENFORCE
// would 403 every login/signup. NOTE: cross-site (sameSite:'none') deployments
// still need that cookie attribute set at the deploy-config layer; that is
// out of scope here — see session-cookie.ts / README.
export const CSRF_EXEMPT_KEY = 'csrfExempt';
export const CsrfExempt = (): MethodDecorator & ClassDecorator => SetMetadata(CSRF_EXEMPT_KEY, true);

// Opt-in double-submit CSRF. Off by default (CSRF_ENFORCE=false) so it does not
// break the frontend until the frontend echoes the rio_csrf cookie as the
// X-CSRF-Token header. Turn on only for cross-site (sameSite=none) deployments.
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.csrfEnforce) return true;
    const req = context.switchToHttp().getRequest<Request & { cookies?: Record<string, string> }>();
    if (SAFE_METHODS.has(req.method)) return true;
    const exempt = this.reflector.getAllAndOverride<boolean>(CSRF_EXEMPT_KEY, [context.getHandler(), context.getClass()]);
    if (exempt) return true;

    const cookie = req.cookies?.[CSRF_COOKIE_NAME];
    const header = req.headers['x-csrf-token'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    if (!cookie || !headerValue || cookie !== headerValue) {
      throw new ForbiddenException({ error: { code: 'CSRF_TOKEN_INVALID', message: 'Missing or invalid CSRF token' } });
    }
    return true;
  }
}
