import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { PasswordService } from '../../auth/password.service';
import { DomainsModule } from '../domains/domains.module';
import { GeographyModule } from '../geography/geography.module';
import { UsersModule } from '../users/users.module';
import { MailerModule } from '../../mailer/mailer.module';
import { NicRegistryModule } from '../nic-registry/nic-registry.module';
import { ConsentModule } from '../consent/consent.module';

@Module({
  imports: [DomainsModule, GeographyModule, UsersModule, MailerModule, NicRegistryModule, ConsentModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService, PasswordService],
})
export class OrganizationsModule {}
