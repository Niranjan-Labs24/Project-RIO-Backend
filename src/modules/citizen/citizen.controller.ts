import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { CheckDuplicateBody, RequestOtpBody, SubmitResponseBody, VerifyOtpBody } from './citizen.contract';
import { CitizenService } from './citizen.service';
import type {
  CheckDuplicatePayload, CheckDuplicateResult, RequestOtpPayload, RequestOtpResult, ResolvedSurvey,
  SubmitResponsePayload, SubmitResponseResult, VerifyOtpPayload, VerifyOtpResult,
} from './citizen.types';

// Fully unauthenticated (no @RequirePermission anywhere in this file — see
// ConsentController's GET active for the same "open route" precedent).
// Matches citizen_guest's existing RBAC scaffolding: create-only on
// citizenChannel, no login path at all.
@Controller('public/surveys')
export class CitizenController {
  constructor(private readonly citizen: CitizenService) {}

  @Get(':token')
  resolveSurvey(@Param('token') token: string): Promise<ResolvedSurvey> {
    return this.citizen.resolveSurvey(token);
  }

  @Post(':token/check-duplicate')
  checkDuplicate(
    @Param('token') token: string,
    @Body(new TypeBoxValidationPipe(CheckDuplicateBody)) body: CheckDuplicatePayload,
  ): Promise<CheckDuplicateResult> {
    return this.citizen.checkDuplicate(token, body);
  }

  @Post(':token/otp/request')
  requestOtp(
    @Param('token') token: string,
    @Body(new TypeBoxValidationPipe(RequestOtpBody)) body: RequestOtpPayload,
  ): Promise<RequestOtpResult> {
    return this.citizen.requestOtp(token, body);
  }

  @Post(':token/otp/verify')
  verifyOtp(
    @Param('token') token: string,
    @Body(new TypeBoxValidationPipe(VerifyOtpBody)) body: VerifyOtpPayload,
  ): Promise<VerifyOtpResult> {
    return this.citizen.verifyOtp(token, body);
  }

  @Post(':token/responses')
  submitResponse(
    @Param('token') token: string,
    @Body(new TypeBoxValidationPipe(SubmitResponseBody)) body: SubmitResponsePayload,
  ): Promise<SubmitResponseResult> {
    return this.citizen.submitResponse(token, body);
  }
}
