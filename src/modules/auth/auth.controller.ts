import { BadRequestException, Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '../../config/config.service';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../../auth/session-cookie';
import { AuthService } from './auth.service';
import type { SessionContext } from './session.types';

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  // Open route (no @RequirePermission): this is how a caller obtains a token.
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: LoginBody, @Res({ passthrough: true }) res: Response): Promise<SessionContext> {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'email and password are required' } });
    }
    const session = await this.auth.login(email, password);
    res.cookie(SESSION_COOKIE_NAME, session.token, sessionCookieOptions(this.config.nodeEnv === 'production'));
    return session;
  }

  @Get('me')
  me(): Promise<SessionContext> {
    return this.auth.me();
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout();
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  }

  @Post('consent')
  consent(): Promise<{ consentedAt: string; policyVersion: string | null }> {
    return this.auth.consent();
  }
}
