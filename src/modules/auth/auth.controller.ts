import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '../../config/config.service';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../../common/session.util';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  ChangePasswordBody,
  LoginBody,
  SignupBody,
  type ChangePasswordDto,
  type LoginDto,
  type SessionView,
  type SignupDto,
  type SignupResponseView,
} from './auth.contract';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly service: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('signup')
  async signup(
    @Body(new TypeBoxValidationPipe(SignupBody)) body: SignupDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignupResponseView> {
    const session = await this.service.signup(body);
    res.cookie(SESSION_COOKIE_NAME, session.token, sessionCookieOptions(this.config.nodeEnv));
    return session;
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new TypeBoxValidationPipe(LoginBody)) body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionView> {
    const session = await this.service.login(body);
    res.cookie(SESSION_COOKIE_NAME, session.token, sessionCookieOptions(this.config.nodeEnv));
    return session;
  }

  @Get('me')
  async me(@Req() req: Request): Promise<SessionView> {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE_NAME];
    if (!token) {
      throw new UnauthorizedException({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated.' },
      });
    }
    return this.service.resolveSession(token);
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @Req() req: Request,
    @Body(new TypeBoxValidationPipe(ChangePasswordBody)) body: ChangePasswordDto,
  ): Promise<SessionView> {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE_NAME];
    if (!token) {
      throw new UnauthorizedException({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated.' },
      });
    }
    return this.service.changePassword(token, body);
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response): { message: string } {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { message: 'Logged out.' };
  }
}
