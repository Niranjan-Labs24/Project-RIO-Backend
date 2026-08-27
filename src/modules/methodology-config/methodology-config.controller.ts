import { Body, Controller, Get, Patch, Post } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { TypeBoxValidationPipe } from "../../contract/validation.pipe";
import {
  ApproveMethodologyConfigBody, ApproveMethodologyConfigDto,
  RejectMethodologyConfigBody, RejectMethodologyConfigDto,
  UpdateMethodologyConfigBody,
} from "./methodology-config.contract";
import { MethodologyConfigService } from "./methodology-config.service";
import type {
  MethodologyConfig, MethodologyConfigHistoryEntry, MethodologyVersionOption,
  UpdateMethodologyConfigPayload,
} from "./methodology-config.types";

@Controller("methodology-config")
export class MethodologyConfigController {
  constructor(private readonly methodologyConfig: MethodologyConfigService) {}

  @Get()
  @RequirePermission("methodologyQuestionBank", "read")
  get(): Promise<MethodologyConfig> {
    return this.methodologyConfig.get();
  }

  // Read-only for both Researcher (surveyBuilder/write, picks a version)
  // and Approver (surveyBuilder/approve, reviews it) — both roles already
  // have methodologyQuestionBank/read (see role-matrix.ts).
  @Get("versions")
  @RequirePermission("methodologyQuestionBank", "read")
  listVersionOptions(): Promise<MethodologyVersionOption[]> {
    return this.methodologyConfig.listVersionOptions();
  }

  @Patch()
  @RequirePermission("methodologyQuestionBank", "write")
  update(
    @Body(new TypeBoxValidationPipe(UpdateMethodologyConfigBody)) body: UpdateMethodologyConfigPayload,
  ): Promise<MethodologyConfig> {
    return this.methodologyConfig.update(body);
  }

  // System Reviewer only — required before System Admin can publish.
  @Patch("approve")
  @RequirePermission("methodologyQuestionBank", "approve")
  approve(
    @Body(new TypeBoxValidationPipe(ApproveMethodologyConfigBody)) body: ApproveMethodologyConfigDto,
  ): Promise<MethodologyConfig> {
    return this.methodologyConfig.approve(body.notes);
  }

  @Patch("reject")
  @RequirePermission("methodologyQuestionBank", "approve")
  reject(
    @Body(new TypeBoxValidationPipe(RejectMethodologyConfigBody)) body: RejectMethodologyConfigDto,
  ): Promise<MethodologyConfig> {
    return this.methodologyConfig.reject(body.notes);
  }

  @Post("publish")
  @RequirePermission("methodologyQuestionBank", "write")
  publish(): Promise<MethodologyConfig> {
    return this.methodologyConfig.publish();
  }

  // RIO-NFR-017 — every past edit/publish, newest first.
  @Get("history")
  @RequirePermission("methodologyQuestionBank", "read")
  getHistory(): Promise<MethodologyConfigHistoryEntry[]> {
    return this.methodologyConfig.getHistory();
  }
}
