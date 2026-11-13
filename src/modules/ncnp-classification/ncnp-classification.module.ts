import { Global, Module } from '@nestjs/common';
import { NcnpClassificationController } from './ncnp-classification.controller';
import { NcnpClassificationService } from './ncnp-classification.service';

// Global: organisations, sign-up and the archive all resolve classifications.
@Global()
@Module({
  controllers: [NcnpClassificationController],
  providers: [NcnpClassificationService],
  exports: [NcnpClassificationService],
})
export class NcnpClassificationModule {}
