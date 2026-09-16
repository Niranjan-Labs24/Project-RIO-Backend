import { Module } from '@nestjs/common';
import { PermissionGrantsController } from './permission-grants.controller';
import { PermissionGrantsService } from './permission-grants.service';

@Module({
  controllers: [PermissionGrantsController],
  providers: [PermissionGrantsService],
  exports: [PermissionGrantsService],
})
export class PermissionGrantsModule {}
