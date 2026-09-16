import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { Public } from '../../auth/public.decorator';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { CheckDuplicateBody, RequestOtpBody, SubmitResponseBody, VerifyOtpBody } from './citizen.contract';
import { RecordSessionEventBody, type RecordSessionEventDto } from '../survey-sessions/survey-sessions.contract';
import type { RecordEventResult, StartSessionResult } from '../survey-sessions/survey-sessions.types';
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
@Public()
export class CitizenController {
  constructor(private readonly citizen: CitizenService) {}

  @Get(':token')
  resolveSurvey(@Param('token') token: string): Promise<ResolvedSurvey> {
    return this.citizen.resolveSurvey(token);
  }

  // ── Abandonment tracking (RPT10 Q-2, client answer 24 Aug) ──
  // Opened when the citizen page loads, so a sitting that is never submitted
  // still leaves a record THAT it happened. Nothing about the answers is
  // posted to either route — see RecordSessionEventBody, which has no field
  // that could carry one.
  //
  // Rate limits are generous relative to the OTP routes: this is telemetry a
  // single respondent legitimately posts once per step, and throttling it
  // would silently bias the drop-off figures towards "abandoned early".
  @Post(':token/sessions')
  @RateLimit(10, 60)
  startSession(@Param('token') token: string): Promise<StartSessionResult | null> {
    return this.citizen.startSession(token);
  }

  @Post(':token/sessions/:sessionId/events')
  @RateLimit(60, 60)
  recordSessionEvent(
    @Param('token') token: string,
    @Param('sessionId') sessionId: string,
    @Body(new TypeBoxValidationPipe(RecordSessionEventBody)) body: RecordSessionEventDto,
  ): Promise<RecordEventResult> {
    return this.citizen.recordSessionEvent(token, sessionId, body);
  }

  @Post(':token/check-duplicate')
  @RateLimit(20, 60)
  checkDuplicate(
    @Param('token') token: string,
    @Body(new TypeBoxValidationPipe(CheckDuplicateBody)) body: CheckDuplicatePayload,
  ): Promise<CheckDuplicateResult> {
    return this.citizen.checkDuplicate(token, body);
  }

  @Post(':token/otp/request')
  @RateLimit(3, 600)
  requestOtp(
    @Param('token') token: string,
    @Body(new TypeBoxValidationPipe(RequestOtpBody)) body: RequestOtpPayload,
  ): Promise<RequestOtpResult> {
    return this.citizen.requestOtp(token, body);
  }

  @Post(':token/otp/verify')
  @RateLimit(10, 600)
  verifyOtp(
    @Param('token') token: string,
    @Body(new TypeBoxValidationPipe(VerifyOtpBody)) body: VerifyOtpPayload,
  ): Promise<VerifyOtpResult> {
    return this.citizen.verifyOtp(token, body);
  }

  @Post(':token/responses')
  @RateLimit(5, 600)
  submitResponse(
    @Param('token') token: string,
    @Body(new TypeBoxValidationPipe(SubmitResponseBody)) body: SubmitResponsePayload,
  ): Promise<SubmitResponseResult> {
    return this.citizen.submitResponse(token, body);
  }
}
