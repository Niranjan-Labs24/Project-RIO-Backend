import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma';
import { ConfigService } from '../config/config.service';
import { pgSslOption } from './pg-ssl';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    // Runtime uses the restricted NOBYPASSRLS role (APP_DATABASE_URL) via a
    // driver adapter, overriding the schema's owner connection used by the
    // CLI (configured separately in prisma.config.ts). Prisma 7 requires an
    // explicit adapter instead of a bare datasourceUrl string.
    // RIO-NFR-006 — explicit pool size (was implicitly the pg.Pool default
    // of 10, the exact bottleneck the 2026-07-27 load test reproduced under
    // concurrency — see load-test/README.md and DB_POOL_MAX's own comment).
    super({ adapter: new PrismaPg({ connectionString: config.appDatabaseUrl, max: config.dbPoolMax, ssl: pgSslOption({ enabled: config.dbSsl, rejectUnauthorized: config.dbSslRejectUnauthorized, caPath: config.dbSslCaPath }) }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
