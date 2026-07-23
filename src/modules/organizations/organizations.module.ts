import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { PasswordService } from '../../auth/password.service';
import { DomainsModule } from '../domains/domains.module';
import { GeographyModule } from '../geography/geography.module';

@Module({
  imports: [DomainsModule, GeographyModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService, PasswordService],
})
export class OrganizationsModule {}
