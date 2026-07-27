import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '../config/config.service';

const QUIT_TIMEOUT_MS = 3000;
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * The one Redis connection this process owns — used by RateLimitGuard's
 * distributed counters and HealthController's readiness check. Previously
 * RateLimitGuard opened its own private client with a silent `on('error')`
 * listener and no shutdown hook; that meant a Redis outage produced zero
 * observability, and SIGTERM never gracefully closed the connection (relying
 * on the OS to tear down the socket instead of `quit()` flushing in-flight
 * commands first).
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  readonly client?: Redis;
  private lastErrorLoggedAt = 0;

  constructor(config: ConfigService) {
    if (!config.redisUrl) return;
    this.client = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    // Rate-limited rather than silent: ioredis retries continuously during
    // an outage and would otherwise flood the log with one line per retry.
    // Never includes the error's own message verbatim — ioredis connection
    // errors can embed the resolved host/port from REDIS_URL.
    this.client.on('error', () => {
      const now = Date.now();
      if (now - this.lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) return;
      this.lastErrorLoggedAt = now;
      this.logger.error('Redis connection error (see ioredis retry backoff; suppressing repeats for 30s)');
    });
  }

  /** Used by HealthController's readiness check — never throws. */
  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      if (this.client.status === 'wait') await this.client.connect();
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Graceful shutdown: `quit()` flushes any in-flight command and closes
   * the connection cleanly. Bounded so a hung Redis connection can never
   * block the app's own shutdown — `disconnect()` (immediate, no flush) is
   * the fallback if `quit()` doesn't resolve in time.
   */
  async onApplicationShutdown(): Promise<void> {
    if (!this.client) return;
    try {
      await Promise.race([
        this.client.quit(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('quit timeout')), QUIT_TIMEOUT_MS)),
      ]);
    } catch {
      this.client.disconnect();
    }
  }
}
