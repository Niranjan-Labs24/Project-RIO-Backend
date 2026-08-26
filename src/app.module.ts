import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { PermissionGuard } from './common/guards/permission.guard';
import { CsrfGuard } from './common/guards/csrf.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { TokenService } from './auth/token.service';
import { ConfigModule } from './config/config.module';
import { ConfigService } from './config/config.service';
import { buildLoggerConfig } from './common/logger/logger.config';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { OrgContextMiddleware } from './tenancy/org-context.middleware';
import { HealthModule } from './health/health.module';
import { RolesModule } from './modules/roles/roles.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuditModule } from './modules/audit/audit.module';
import { SystemLogsModule } from './modules/system-logs/system-logs.module';
import { ContactModule } from './modules/contact/contact.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { UsersModule } from './modules/users/users.module';
import { ConsentModule } from './modules/consent/consent.module';
import { StudiesModule } from './modules/studies/studies.module';
import { NeedsModule } from './modules/needs/needs.module';
import { EvidenceModule } from './modules/evidence/evidence.module';
import { AiDecisionsModule } from './modules/ai-decisions/ai-decisions.module';
import { DomainsModule } from './modules/domains/domains.module';
import { StudyConfigModule } from './modules/study-config/study-config.module';
import { NeedDecisionsModule } from './modules/need-decisions/need-decisions.module';
import { GeographyModule } from './modules/geography/geography.module';
import { MethodologyConfigModule } from './modules/methodology-config/methodology-config.module';
import { SupervisorOverviewModule } from './modules/supervisor-overview/supervisor-overview.module';
import { NcnpReportModule } from './modules/ncnp-report/ncnp-report.module';
import { NcnpReportReviewModule } from './modules/ncnp-report-review/ncnp-report-review.module';
import { PublicSurveysModule } from './modules/public-surveys/public-surveys.module';
import { CitizenModule } from './modules/citizen/citizen.module';
import { SurveySessionsModule } from './modules/survey-sessions/survey-sessions.module';
import { ResponseQualityModule } from './modules/response-quality/response-quality.module';
import { PriorityModule } from './modules/priority/priority.module';
import { SharingModule } from './modules/sharing/sharing.module';
import { ReportSharingModule } from './modules/report-sharing/report-sharing.module';
import { SharingAlertsModule } from './modules/sharing-alerts/sharing-alerts.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ArchiveModule } from './modules/archive/archive.module';
import { ReviewerSlaModule } from './modules/reviewer-sla/reviewer-sla.module';
import { CollectiveDashboardModule } from './modules/collective-dashboard/collective-dashboard.module';
import { AiModule } from './modules/ai/ai.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { QuestionBankAlertsModule } from './modules/question-bank-alerts/question-bank-alerts.module';
import { PermissionGrantsModule } from './modules/permission-grants/permission-grants.module';
import { SurveysModule } from './modules/surveys/surveys.module';
import { BackupModule } from './modules/backup/backup.module';
import { OperationalLogInterceptor } from './common/interceptors/operational-log.interceptor';
import { AppController } from './app.controller';

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
    // Global: makes SchedulerRegistry injectable anywhere (BackupModule)
    // without importing ScheduleModule again there.
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    TenancyModule,
    HealthModule,
    RolesModule,
    AuthModule,
    AuditModule,
    // RIO-NFR-016 — operational logging. Global, like AuditModule: any
    // service, filter or job may need to record an operational event.
    SystemLogsModule,
    ContactModule,
    OrganizationsModule,
    UsersModule,
    ConsentModule,
    StudiesModule,
    NeedsModule,
    EvidenceModule,
    AiDecisionsModule,
    DomainsModule,
    StudyConfigModule,
    NeedDecisionsModule,
    GeographyModule,
    MethodologyConfigModule,
    SupervisorOverviewModule,
    NcnpReportModule,
    NcnpReportReviewModule,
    PublicSurveysModule,
    CitizenModule,
    SurveySessionsModule,
    ResponseQualityModule,
    PriorityModule,
    SharingModule,
    ReportSharingModule,
    SharingAlertsModule,
    ReportsModule,
    ArchiveModule,
    ReviewerSlaModule,
    CollectiveDashboardModule,
    AiModule,
    QuestionsModule,
    QuestionBankAlertsModule,
    SurveysModule,
    BackupModule,
    PermissionGrantsModule,
  ],
  controllers: [AppController],
  providers: [
    TokenService,
    // RIO-NFR-016 — persists the outcome of successful requests (slow ones
    // always, ordinary ones sampled). Every 4xx and 5xx is recorded by
    // AllExceptionsFilter instead: guards run before interceptors, so a 401
    // or 403 never reaches this one.
    { provide: APP_INTERCEPTOR, useClass: OperationalLogInterceptor },
    { provide: APP_GUARD, useClass: RateLimitGuard },
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
