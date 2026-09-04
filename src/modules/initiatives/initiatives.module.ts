import { Module } from '@nestjs/common';
import { InitiativesController, NeedInitiativesController } from './initiatives.controller';
import { InitiativesService } from './initiatives.service';

@Module({
  controllers: [InitiativesController, NeedInitiativesController],
  providers: [InitiativesService],
  exports: [InitiativesService],
})
export class InitiativesModule {}
