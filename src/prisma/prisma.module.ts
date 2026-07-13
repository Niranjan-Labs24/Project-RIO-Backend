import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SupervisorPrismaService } from './supervisor-prisma.service';

@Global()
@Module({
  providers: [PrismaService, SupervisorPrismaService],
  exports: [PrismaService, SupervisorPrismaService],
})
export class PrismaModule {}
