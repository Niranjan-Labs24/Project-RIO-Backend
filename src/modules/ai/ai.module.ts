import { Global, Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { ConfigModule } from '../../config/config.module';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
