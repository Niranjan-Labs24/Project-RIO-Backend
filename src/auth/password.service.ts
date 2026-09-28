import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ConfigService } from '../config/config.service';

/**
 * Runs at most `max` promises concurrently; anything beyond that queues (FIFO)
 * instead of all starting at once. Used to cap concurrent argon2 work — see
 * PasswordService's comment for why.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

@Injectable()
export class PasswordService {
  // Lazily-computed argon2id hash of a throwaway secret. Verifying against it on
  // the "user not found / no password" login path equalises response time with
  // the real-user path, mitigating username enumeration via timing.
  private dummyHash?: Promise<string>;

  // argon2id is deliberately CPU/memory-hard. Letting every concurrent login
  // fire its own hash/verify at once doesn't parallelise for free — it just
  // makes all of them slower together by thrashing the same physical cores,
  // reproduced directly under RIO-NFR-005's 500-concurrent load test (median
  // login latency ~2.2s with all requests hitting argon2 at once). Capping
  // concurrency queues the excess instead, so each one that *is* running gets
  // real CPU rather than time-sliced scraps of it.
  private readonly limiter: ConcurrencyLimiter;

  constructor(config: ConfigService) {
    this.limiter = new ConcurrencyLimiter(config.argon2MaxConcurrency);
  }

  hash(plain: string): Promise<string> {
    return this.limiter.run(() => argon2.hash(plain, { type: argon2.argon2id }));
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await this.limiter.run(() => argon2.verify(hash, plain));
    } catch {
      return false;
    }
  }

  // Always returns false; exists only to burn a comparable amount of CPU as a
  // real verify so the not-found path is not observably faster.
  async verifyDummy(plain: string): Promise<false> {
    this.dummyHash ??= this.limiter.run(() =>
      argon2.hash('argon2-timing-equaliser', { type: argon2.argon2id }),
    );
    await this.verify(await this.dummyHash, plain);
    return false;
  }
}
