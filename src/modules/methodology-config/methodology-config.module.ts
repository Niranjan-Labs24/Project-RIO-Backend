import { Module } from "@nestjs/common";
import { MethodologyConfigController } from "./methodology-config.controller";
import { MethodologyConfigService } from "./methodology-config.service";

@Module({
  controllers: [MethodologyConfigController],
  providers: [MethodologyConfigService],
  exports: [MethodologyConfigService],
})
export class MethodologyConfigModule {}
