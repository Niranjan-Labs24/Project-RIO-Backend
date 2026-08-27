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
    //
    // `max` matters: every request (even a read) opens its own interactive
    // transaction here for the per-request RLS org context (see
    // TenantPrismaService), so pg.Pool's undocumented default of 10 becomes
    // the app's real concurrency ceiling — reproduced directly by
    // RIO-NFR-005's 500-concurrent-session load test (see DB_POOL_MAX_APP's
    // comment in env.schema.ts).
    super({
      adapter: new PrismaPg({
        connectionString: config.appDatabaseUrl,
        max: config.dbPoolMaxApp,
        ssl: pgSslOption({ enabled: config.dbSsl, rejectUnauthorized: config.dbSslRejectUnauthorized, caPath: config.dbSslCaPath }),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
