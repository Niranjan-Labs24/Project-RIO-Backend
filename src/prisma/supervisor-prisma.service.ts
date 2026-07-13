import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma';
import { ConfigService } from '../config/config.service';
import { pgSslOption } from './pg-ssl';

// Cross-org READ-only client. Connects with the cnap_supervisor role
// (NOBYPASSRLS, SELECT-only) via SUPERVISOR_DATABASE_URL. Used only by
// TenantPrismaService.runAsSupervisor for crossEntity roles' read path;
// never used for writes (the role has no write grants).
@Injectable()
export class SupervisorPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    super({ adapter: new PrismaPg({ connectionString: config.supervisorDatabaseUrl, ssl: pgSslOption({ enabled: config.dbSsl, rejectUnauthorized: config.dbSslRejectUnauthorized, caPath: config.dbSslCaPath }) }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
