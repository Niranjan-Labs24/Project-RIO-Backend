import { BadRequestException, Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { SessionContext } from './session.types';

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Open route (no @RequirePermission): this is how a caller obtains a token.
  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginBody): Promise<SessionContext> {
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'email and password are required' } });
    }
    return this.auth.login(email, password);
  }

  @Get('me')
  me(): Promise<SessionContext> {
    return this.auth.me();
  }

  @Post('logout')
  @HttpCode(204)
  logout(): void {
    this.auth.logout();
  }

  @Post('consent')
  consent(): Promise<{ consentedAt: string }> {
    return this.auth.consent();
  }
}
