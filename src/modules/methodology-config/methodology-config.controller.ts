import { Body, Controller, Get, Patch, Post } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { TypeBoxValidationPipe } from "../../contract/validation.pipe";
import { UpdateMethodologyConfigBody } from "./methodology-config.contract";
import { MethodologyConfigService } from "./methodology-config.service";
import type { MethodologyConfig, UpdateMethodologyConfigPayload } from "./methodology-config.types";

@Controller("methodology-config")
export class MethodologyConfigController {
  constructor(private readonly methodologyConfig: MethodologyConfigService) {}

  @Get()
  @RequirePermission("methodologyQuestionBank", "read")
  get(): Promise<MethodologyConfig> {
    return this.methodologyConfig.get();
  }

  @Patch()
  @RequirePermission("methodologyQuestionBank", "write")
  update(
    @Body(new TypeBoxValidationPipe(UpdateMethodologyConfigBody)) body: UpdateMethodologyConfigPayload,
  ): Promise<MethodologyConfig> {
    return this.methodologyConfig.update(body);
  }

  @Post("publish")
  @RequirePermission("methodologyQuestionBank", "write")
  publish(): Promise<MethodologyConfig> {
    return this.methodologyConfig.publish();
  }
}
