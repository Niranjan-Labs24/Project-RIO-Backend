import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { PasswordService } from '../../auth/password.service';

@Module({
  controllers: [OrganizationsController],
  providers: [OrganizationsService, PasswordService],
})
export class OrganizationsModule {}
