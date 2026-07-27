import { Controller, Get, HttpException, Logger } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
@Public()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // Deliberately returns only a stable DB_UNAVAILABLE code — the raw
  // exception message (previously returned verbatim) can carry connection
  // details, hostnames, or query fragments that shouldn't reach a public
  // client. The real cause is still logged, server-side only.
  @Get('db')
  async readiness(): Promise<{ status: 'ok' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch (e) {
      this.logger.error(`Database readiness check failed: ${(e as Error).message}`);
      throw new HttpException(
        { error: { code: 'DB_UNAVAILABLE', message: 'Database is currently unavailable' } },
        503,
      );
    }
  }

  @Get('redis')
  async redisReadiness(): Promise<{ status: 'ok' }> {
    const ok = await this.redis.ping();
    if (!ok) {
      throw new HttpException(
        { error: { code: 'REDIS_UNAVAILABLE', message: 'Redis is currently unavailable' } },
        503,
      );
    }
    return { status: 'ok' };
  }
}
