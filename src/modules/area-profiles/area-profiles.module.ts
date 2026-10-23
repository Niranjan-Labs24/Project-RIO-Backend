import { Module } from "@nestjs/common";
import { AreaProfilesController } from "./area-profiles.controller";
import { AreaProfilesService } from "./area-profiles.service";

@Module({
  controllers: [AreaProfilesController],
  providers: [AreaProfilesService],
})
export class AreaProfilesModule {}
