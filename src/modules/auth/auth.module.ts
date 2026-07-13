import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from '../../auth/password.service';
import { TokenService } from '../../auth/token.service';

// JwtModule is registered globally in AppModule, so TokenService resolves here.
@Module({
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService],
})
export class AuthModule {}
