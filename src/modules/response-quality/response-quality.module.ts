import { Module } from "@nestjs/common";
import { MethodologyConfigModule } from "../methodology-config/methodology-config.module";
import { ResponseQualityController } from "./response-quality.controller";
import { ResponseQualityService } from "./response-quality.service";

@Module({
  imports: [MethodologyConfigModule],
  controllers: [ResponseQualityController],
  providers: [ResponseQualityService],
})
export class ResponseQualityModule {}
