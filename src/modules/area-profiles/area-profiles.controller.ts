import { Body, Controller, Delete, Get, HttpCode, Param, Put } from "@nestjs/common";
import { UuidParamPipe } from "../../common/pipes/uuid-param.pipe";
import { RequirePermission } from "../../common/guards/permission.guard";
import { TypeBoxValidationPipe } from "../../contract/validation.pipe";
import { SaveAreaProfileBody, type SaveAreaProfileDto } from "./area-profiles.contract";
import { AreaProfilesService, type AreaProfileRow } from "./area-profiles.service";

// Area profile admin entry (Methodology Settings → Area profiles). Same
// permission as the rest of Methodology Settings: NCNP-level read, System
// Admin write.
@Controller("area-profiles")
export class AreaProfilesController {
  constructor(private readonly areaProfiles: AreaProfilesService) {}

  @Get()
  @RequirePermission("methodologyQuestionBank", "read")
  list(): Promise<AreaProfileRow[]> {
    return this.areaProfiles.list();
  }

  @Put()
  @RequirePermission("methodologyQuestionBank", "write")
  save(@Body(new TypeBoxValidationPipe(SaveAreaProfileBody)) body: SaveAreaProfileDto): Promise<AreaProfileRow> {
    return this.areaProfiles.save(body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("methodologyQuestionBank", "write")
  async remove(@Param("id", new UuidParamPipe()) id: string): Promise<void> {
    await this.areaProfiles.remove(id);
  }
}
