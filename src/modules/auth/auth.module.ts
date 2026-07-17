import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { PasswordService } from '../../auth/password.service';
import { TokenService } from '../../auth/token.service';
import { MailerModule } from '../../mailer/mailer.module';
import { DomainsModule } from '../domains/domains.module';

// JwtModule is registered globally in AppModule, so TokenService resolves here.
// ConfigService, TenantPrismaService, AuditService come from @Global() modules.
@Module({
  imports: [MailerModule, DomainsModule],
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, PasswordService, TokenService],
})
export class AuthModule {}
