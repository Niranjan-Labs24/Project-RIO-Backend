import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import Redis from 'ioredis';
import { ConfigService } from '../../config/config.service';

const RATE_LIMIT_KEY = 'rateLimit';
interface RateLimitPolicy { limit: number; windowSeconds: number; }

export const RateLimit = (limit: number, windowSeconds: number): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowSeconds } satisfies RateLimitPolicy);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly redis?: Redis;
  private readonly distributedRequired: boolean;
  private readonly local = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly reflector: Reflector, config: ConfigService) {
    this.distributedRequired = config.nodeEnv === 'production';
    if (config.redisUrl) {
      this.redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
      this.redis.on('error', () => undefined);
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<RateLimitPolicy>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (!policy) return true;
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const { count, ttl } = await this.increment(this.keyFor(req), policy.windowSeconds);
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

  private keyFor(req: Request): string {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const identifier = String(body.email ?? body.contact ?? body.challengeId ?? req.params?.token ?? 'anonymous').trim().toLowerCase();
    const digest = createHash('sha256').update(identifier).digest('hex');
    return `rio:rate:${req.method}:${req.route?.path ?? req.path}:${req.ip}:${digest}`;
  }

  private async increment(key: string, windowSeconds: number): Promise<{ count: number; ttl: number }> {
    if (this.redis) {
      try {
        if (this.redis.status === 'wait') await this.redis.connect();
        const result = await this.redis.multi().incr(key).expire(key, windowSeconds, 'NX').ttl(key).exec();
        return {
          count: Number(result?.[0]?.[1] ?? 1),
          ttl: Math.max(1, Number(result?.[2]?.[1] ?? windowSeconds)),
        };
      } catch {
        if (this.distributedRequired) {
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
    const current = this.local.get(key);
    if (!current || current.resetAt <= now) {
      this.local.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { count: 1, ttl: windowSeconds };
    }
    current.count += 1;
    return { count: current.count, ttl: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
}
