import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ConfigService } from '../../config/config.service';
import { RedisService } from '../../redis/redis.service';
import { getOrgStore } from '../../tenancy/org-context';

const RATE_LIMIT_KEY = 'rateLimit';
interface RateLimitPolicy {
  limit: number;
  windowSeconds: number;
  /** What to do if Redis (the shared counter store) is unreachable in
   *  production. Per the client's answer (2026-09): block on login/other
   *  identity-sensitive endpoints (the safer default, `false`/omitted), but
   *  let ordinary read/list screens through unprotected rather than take
   *  the whole app down with the counter store (`true`). */
  failOpenOnOutage?: boolean;
  /** Extra ceiling per client IP across ALL identifiers, for unauthenticated routes only.
   *  The main counter is keyed on IP + identifier (email/contact), so on its own it lets
   *  one address try unlimited different identifiers. */
  perIp?: { limit: number; windowSeconds: number };
}

export const RateLimit = (
  limit: number,
  windowSeconds: number,
  options?: { failOpenOnOutage?: boolean; perIp?: { limit: number; windowSeconds: number } },
): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowSeconds, ...options } satisfies RateLimitPolicy);

// Default tiers applied to every endpoint that has no explicit @RateLimit()
// of its own — client-confirmed figures (2026-09) for "screen loads, lists,
// lookups" (GET) vs. "save actions" (POST/PUT/PATCH/DELETE). Both fail open
// on a counter-store outage: normal use of the app must not go down because
// Redis did. Endpoints that need a stricter tier (AI calls, exports) or a
// stricter outage behaviour (auth) carry their own @RateLimit() and take
// precedence over this default — see ai-decisions/need-summary/response-
// quality/evidence controllers (AI, 30/min) and reports/ncnp-report/audit/
// system-logs/public-surveys controllers (exports, 10/min).
const DEFAULT_READ_POLICY: RateLimitPolicy = { limit: 300, windowSeconds: 60, failOpenOnOutage: true };
const DEFAULT_WRITE_POLICY: RateLimitPolicy = { limit: 60, windowSeconds: 60, failOpenOnOutage: true };

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly distributedRequired: boolean;
  private readonly local = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.distributedRequired = config.nodeEnv === 'production';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const explicit = this.reflector.getAllAndOverride<RateLimitPolicy>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const policy = explicit ?? (this.isReadMethod(req.method) ? DEFAULT_READ_POLICY : DEFAULT_WRITE_POLICY);

    if (policy.perIp && !getOrgStore()?.actorId) {
      const ipResult = await this.increment(`rio:rate:ip:${req.method}:${req.route?.path ?? req.path}:${req.ip}`, {
        ...policy.perIp,
        failOpenOnOutage: policy.failOpenOnOutage,
      });
      if (ipResult !== 'outage-allowed' && ipResult.count > policy.perIp.limit) {
        res.setHeader('Retry-After', ipResult.ttl);
        throw new HttpException(
          { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const result = await this.increment(this.keyFor(req), policy);
    if (result === 'outage-allowed') return true;
    const { count, ttl } = result;
    res.setHeader('RateLimit-Limit', policy.limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, policy.limit - count));
    res.setHeader('RateLimit-Reset', ttl);
    if (count > policy.limit) {
      res.setHeader('Retry-After', ttl);
      throw new HttpException(
        { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  /** Drops expired local counters (at most once a minute) so the fallback map cannot grow without bound. */
  private lastPruneAt = 0;
  private pruneExpired(now: number): void {
    if (now - this.lastPruneAt < 60_000) return;
    this.lastPruneAt = now;
    for (const [key, entry] of this.local) {
      if (entry.resetAt <= now) this.local.delete(key);
    }
  }

  private isReadMethod(method: string): boolean {
    return method === 'GET' || method === 'HEAD';
  }

  private keyFor(req: Request): string {
    // Authenticated requests key on the signed-in account (set by
    // JwtAuthGuard, which now runs before this guard — see app.module.ts) so
    // one account can't starve another sharing the same office network, and
    // a supervisory/cross-org role isn't blocked by everyone else's traffic.
    // Public routes (login, OTP, signup, password reset) have no actorId yet
    // — those fall back to the same body-derived identifier this guard
    // always used, since that's the only identity available pre-auth.
    const actorId = getOrgStore()?.actorId;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const identifier = actorId
      ? `user:${actorId}`
      : String(body.email ?? body.contact ?? body.challengeId ?? req.params?.token ?? 'anonymous')
          .trim()
          .toLowerCase();
    const digest = createHash('sha256').update(identifier).digest('hex');
    return `rio:rate:${req.method}:${req.route?.path ?? req.path}:${req.ip}:${digest}`;
  }

  private async increment(
    key: string,
    policy: RateLimitPolicy,
  ): Promise<{ count: number; ttl: number } | 'outage-allowed'> {
    const { windowSeconds } = policy;
    const redis = this.redisService.client;
    if (redis) {
      try {
        if (redis.status === 'wait') await redis.connect();
        const result = await redis.multi().incr(key).expire(key, windowSeconds, 'NX').ttl(key).exec();
        return {
          count: Number(result?.[0]?.[1] ?? 1),
          ttl: Math.max(1, Number(result?.[2]?.[1] ?? windowSeconds)),
        };
      } catch (error) {
        this.logger.error(`Rate limit store error: ${String(error)}`);
        if (this.distributedRequired) {
          if (policy.failOpenOnOutage) {
            // Client decision (2026-09): a counter-store outage should not
            // take ordinary read screens down with it — let the request
            // through uncounted rather than 503. Identity-sensitive
            // endpoints (login, OTP, password reset) don't set this flag,
            // so they keep failing closed below.
            this.logger.warn(`Rate limit store unavailable; failing open for ${key}`);
            return 'outage-allowed';
          }
          throw new HttpException(
            { error: { code: 'RATE_LIMIT_UNAVAILABLE', message: 'Request protection is temporarily unavailable.' } },
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }
        // Local fallback keeps development available; production compose
        // supplies Redis so counters are shared across application instances.
      }
    }
    const now = Date.now();
    this.pruneExpired(now);
    const current = this.local.get(key);
    if (!current || current.resetAt <= now) {
      this.local.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { count: 1, ttl: windowSeconds };
    }
    current.count += 1;
    return { count: current.count, ttl: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
}
