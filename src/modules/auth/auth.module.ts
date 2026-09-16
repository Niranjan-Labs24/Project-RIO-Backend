import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { PasswordService } from '../../auth/password.service';
import { TokenService } from '../../auth/token.service';
import { MailerModule } from '../../mailer/mailer.module';
import { DomainsModule } from '../domains/domains.module';
import { GeographyModule } from '../geography/geography.module';
import { NicRegistryModule } from '../nic-registry/nic-registry.module';
import { ConsentModule } from '../consent/consent.module';
import { PermissionGrantsModule } from '../permission-grants/permission-grants.module';
import { SmsModule } from '../../sms/sms.module';

// JwtModule is registered globally in AppModule, so TokenService resolves here.
// ConfigService, TenantPrismaService, AuditService come from @Global() modules.
@Module({
  imports: [
    MailerModule,
    DomainsModule,
    GeographyModule,
    NicRegistryModule,
    ConsentModule,
    PermissionGrantsModule,
    // RIO MFA — "Sign in with OTP" over SMS reuses the same SmsService the
    // citizen public-survey flow already uses.
    SmsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, PasswordService, TokenService],
})
export class AuthModule {}
