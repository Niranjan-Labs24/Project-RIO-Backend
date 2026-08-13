import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '../../config/config.service';
import { Public } from '../../auth/public.decorator';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { CSRF_COOKIE_NAME, csrfCookieOptions, SESSION_COOKIE_NAME, sessionCookieOptions } from '../../auth/session-cookie';
import { CsrfExempt } from '../../common/guards/csrf.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  ChangePasswordBody, ForgotPasswordBody, LoginBody, ResetPasswordBody, SignupBody, VerifyRegistrationNumberBody,
  type ChangePasswordDto, type ForgotPasswordDto, type LoginDto, type ResetPasswordDto, type SignupDto,
  type VerifyRegistrationNumberDto, type VerifyRegistrationNumberView,
} from './auth.contract';
import { NicRegistryService } from '../nic-registry/nic-registry.service';
import { AuthService } from './auth.service';
import type { SessionContext, SignupPendingApprovalView } from './session.types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly nicRegistry: NicRegistryService,
  ) {}

  // Open route (no @RequirePermission): this is how a caller obtains a token.
  // CSRF-exempt: login issues the rio_csrf cookie, so no cookie exists yet for
  // this request to double-submit — it establishes the session, not consumes it.
  @Post('login')
  @Public()
  @RateLimit(5, 60)
  @HttpCode(200)
  @CsrfExempt()
  async login(
    @Body(new TypeBoxValidationPipe(LoginBody)) body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionContext> {
    const email = body.email.trim().toLowerCase();
    const password = body.password;
    const session = await this.auth.login(email, password);
    res.cookie(SESSION_COOKIE_NAME, session.token, sessionCookieOptions(this.config.nodeEnv === 'production'));
    res.cookie(CSRF_COOKIE_NAME, randomBytes(18).toString('base64url'), csrfCookieOptions(this.config.nodeEnv === 'production'));
    return session;
  }

  // Open route (no @RequirePermission): public NGO signup creates the org +
  // first admin. RIO-FR-010 (client-confirmed): no session/cookies are
  // issued here anymore — self-registration requires Center (System Admin)
  // approval before activation (see AuthService.signup). The entity logs in
  // normally via POST /auth/login once approved.
  @Post('signup')
  @Public()
  @RateLimit(3, 3600)
  @CsrfExempt()
  async signup(
    @Body(new TypeBoxValidationPipe(SignupBody)) body: SignupDto,
  ): Promise<SignupPendingApprovalView> {
    return this.auth.signup(body);
  }

  // Open route, same reasoning as signup itself: it's called from the signup
  // form, before any session exists. Returns a bare verdict and no registry
  // data, and is rate-limited well below what bulk-enumerating a ~7.8k-row
  // register would need — 20/hour is generous for someone checking their own
  // number and retyping a typo or two.
  //
  // 200 with `verified: false` rather than a 4xx: "that number isn't in the
  // registry" is a successful answer to the question the button asks, and the
  // form renders it as field state, not as a failed request.
  @Post('verify-registration-number')
  @Public()
  @RateLimit(20, 3600)
  @HttpCode(200)
  @CsrfExempt()
  async verifyRegistrationNumber(
    @Body(new TypeBoxValidationPipe(VerifyRegistrationNumberBody)) body: VerifyRegistrationNumberDto,
  ): Promise<VerifyRegistrationNumberView> {
    const { verified, reason } = await this.nicRegistry.check(body.registrationNumber);
    return reason ? { verified, reason } : { verified };
  }

  // Open routes: unauthenticated by definition (the whole point is to
  // recover access without a session). CSRF-exempt for the same reason as
  // login/signup — no session cookie exists yet for either of these calls
  // to double-submit against.
  @Post('forgot-password')
  @Public()
  @RateLimit(3, 600)
  @HttpCode(200)
  @CsrfExempt()
  forgotPassword(
    @Body(new TypeBoxValidationPipe(ForgotPasswordBody)) body: ForgotPasswordDto,
  ): Promise<{ message: string }> {
    return this.auth.forgotPassword(body);
  }

  @Post('reset-password')
  @Public()
  @RateLimit(10, 600)
  @HttpCode(200)
  @CsrfExempt()
  resetPassword(
    @Body(new TypeBoxValidationPipe(ResetPasswordBody)) body: ResetPasswordDto,
  ): Promise<{ message: string }> {
    return this.auth.resetPassword(body);
  }

  @Get('me')
  me(): Promise<SessionContext> {
    return this.auth.me();
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout();
    // clearCookie must be called with the same attributes the cookie was
    // set with (sameSite/secure) — passing only `path` still works in most
    // browsers, but some browsers only expire the exact attribute
    // combination they stored, leaving the old cookie value visible in
    // devtools even though the session itself is already dead server-side.
    const isProd = this.config.nodeEnv === 'production';
    res.clearCookie(SESSION_COOKIE_NAME, { ...sessionCookieOptions(isProd), maxAge: undefined });
    res.clearCookie(CSRF_COOKIE_NAME, { ...csrfCookieOptions(isProd), maxAge: undefined });
  }

  // RIO-DATA-001 — accepts BOTH consents (use policy + data sharing). Only
  // reached as a re-prompt now that registration captures them up front:
  // accounts created before the split, and anyone stale after a policy bump.
  @Post('consent')
  consent(): Promise<{
    consentedAt: string;
    policyVersion: string | null;
    sharingPolicyVersion: string | null;
  }> {
    return this.auth.consent();
  }

  // Authenticated via requireActor() inside the service — no @RequirePermission,
  // any signed-in user may replace their own (signup-issued temporary) password.
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @Body(new TypeBoxValidationPipe(ChangePasswordBody)) body: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionContext> {
    const session = await this.auth.changePassword(body);
    // changePassword() bumps sessionVersion and mints a fresh token to match
    // (see AuthService#changePassword) — without re-issuing the cookie here,
    // the browser keeps presenting the now-stale pre-change cookie, and the
    // very next cookie-authenticated request (e.g. consent) is correctly
    // rejected by JwtAuthGuard's sessionVersion check.
    res.cookie(SESSION_COOKIE_NAME, session.token, sessionCookieOptions(this.config.nodeEnv === 'production'));
    return session;
  }
}
