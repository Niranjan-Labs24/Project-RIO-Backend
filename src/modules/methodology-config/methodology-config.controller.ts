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

  // Deliberately ungated: every published version's id/version/name label
  // only — no thresholds, weights, or other configuration content. The
  // comment this replaced assumed only "Researcher" (surveyBuilder/write)
  // and "Approver" (surveyBuilder/approve) roles ever view this, and that
  // both already hold methodologyQuestionBank/read — true for NGO Research
  // Officer and Human Reviewer, but NOT for NGO Admin, who also holds
  // surveyBuilder/write (creates/edits surveys) yet has methodologyQuestionBank
  // fully zeroed (client-confirmed 2026-08-20: Methodology Configuration is
  // NCNP-Admin-level only). Any NGO Admin opening a published Survey saw a
  // permanently blank Methodology Version field as a result — the survey's
  // own stored `methodologyVersion` was always correct, but the dropdown had
  // no options to match it against once the versions call 403'd. Same fix
  // pattern as StudyConfigController's Study Type/Target Sector reads.
  @Get("versions")
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
