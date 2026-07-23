import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { LoggerModule } from 'nestjs-pino';
import { PermissionGuard } from './common/guards/permission.guard';
import { CsrfGuard } from './common/guards/csrf.guard';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { TokenService } from './auth/token.service';
import { ConfigModule } from './config/config.module';
import { ConfigService } from './config/config.service';
import { buildLoggerConfig } from './common/logger/logger.config';
import { PrismaModule } from './prisma/prisma.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { OrgContextMiddleware } from './tenancy/org-context.middleware';
import { HealthModule } from './health/health.module';
import { RolesModule } from './modules/roles/roles.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuditModule } from './modules/audit/audit.module';
import { ContactModule } from './modules/contact/contact.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { UsersModule } from './modules/users/users.module';
import { ConsentModule } from './modules/consent/consent.module';
import { StudiesModule } from './modules/studies/studies.module';
import { NeedsModule } from './modules/needs/needs.module';
import { EvidenceModule } from './modules/evidence/evidence.module';
import { AiDecisionsModule } from './modules/ai-decisions/ai-decisions.module';
import { DomainsModule } from './modules/domains/domains.module';
import { GeographyModule } from './modules/geography/geography.module';
import { MethodologyConfigModule } from './modules/methodology-config/methodology-config.module';
import { SupervisorOverviewModule } from './modules/supervisor-overview/supervisor-overview.module';
import { PublicSurveysModule } from './modules/public-surveys/public-surveys.module';
import { CitizenModule } from './modules/citizen/citizen.module';
import { ResponseQualityModule } from './modules/response-quality/response-quality.module';
import { PriorityModule } from './modules/priority/priority.module';
import { SharingModule } from './modules/sharing/sharing.module';
import { ReportSharingModule } from './modules/report-sharing/report-sharing.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ArchiveModule } from './modules/archive/archive.module';
import { ReviewerSlaModule } from './modules/reviewer-sla/reviewer-sla.module';
import { AiModule } from './modules/ai/ai.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { SurveysModule } from './modules/surveys/surveys.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => buildLoggerConfig(config.logLevel),
    }),
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.jwtSecret,
        // `expiresIn` wants ms's StringValue template-literal type; our env
        // value is validated as a string (e.g. '12h') and safe to pass through.
        signOptions: { expiresIn: config.jwtExpiresIn as unknown as number },
      }),
    }),
    PrismaModule,
    TenancyModule,
    HealthModule,
    RolesModule,
    AuthModule,
    AuditModule,
    ContactModule,
    OrganizationsModule,
    UsersModule,
    ConsentModule,
    StudiesModule,
    NeedsModule,
    EvidenceModule,
    AiDecisionsModule,
    DomainsModule,
    GeographyModule,
    MethodologyConfigModule,
    SupervisorOverviewModule,
    PublicSurveysModule,
    CitizenModule,
    ResponseQualityModule,
    PriorityModule,
    SharingModule,
    ReportSharingModule,
    ReportsModule,
    ArchiveModule,
    ReviewerSlaModule,
    AiModule,
    QuestionsModule,
    SurveysModule,
  ],
  controllers: [],
  providers: [
    TokenService,
    // Order matters: JwtAuthGuard populates the OrgStore from the bearer token,
    // then CsrfGuard checks the double-submit token (no-op unless CSRF_ENFORCE=true),
    // then PermissionGuard enforces (module, action) against that role.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(OrgContextMiddleware).forRoutes('*');
  }
}
