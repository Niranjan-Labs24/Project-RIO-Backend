import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma';
import { ConfigService } from '../config/config.service';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    // Runtime uses the restricted NOBYPASSRLS role (APP_DATABASE_URL) via a
    // driver adapter, overriding the schema's owner connection used by the
    // CLI (configured separately in prisma.config.ts). Prisma 7 requires an
    // explicit adapter instead of a bare datasourceUrl string.
    super({ adapter: new PrismaPg({ connectionString: config.appDatabaseUrl }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
