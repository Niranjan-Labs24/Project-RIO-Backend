import { DomainsModule } from '../domains/domains.module';
import { GeographyModule } from '../geography/geography.module';
import { ContactModule } from '../contact/contact.module';
import { Module } from '@nestjs/common';
import { ArchiveModule } from '../archive/archive.module';
import { CitizenModule } from '../citizen/citizen.module';
import { TranslationModule } from './translation.module';
import { PublicTranslationController } from './public-translation.controller';
import { PublicTranslationService } from './public-translation.service';

@Module({
  imports: [ArchiveModule, CitizenModule, TranslationModule, DomainsModule, GeographyModule, ContactModule],
  controllers: [PublicTranslationController],
  providers: [PublicTranslationService],
})
export class PublicTranslationModule {}
