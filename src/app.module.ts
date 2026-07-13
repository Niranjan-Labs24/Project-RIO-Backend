import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { LoggerModule } from 'nestjs-pino';
import { PermissionGuard } from './common/guards/permission.guard';
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
  ],
  controllers: [],
  providers: [
    TokenService,
    // Order matters: JwtAuthGuard populates the OrgStore from the bearer token,
    // then PermissionGuard enforces (module, action) against that role.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(OrgContextMiddleware).forRoutes('*');
  }
}
