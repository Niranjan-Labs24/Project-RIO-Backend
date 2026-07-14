import 'dotenv/config';
import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { ConfigService } from './config/config.service';
import { buildHttpsOptions } from './config/https-options';
import { setupOpenApi } from './contract/openapi';

async function bootstrap(): Promise<void> {
  // Encryption in transit (RIO-NFR-001): serve HTTPS directly when a cert/key
  // are configured; otherwise HTTP (TLS terminated by an ingress/proxy).
  const httpsOptions = buildHttpsOptions(process.env.TLS_CERT_PATH, process.env.TLS_KEY_PATH);
  // Register body parsers ourselves (bodyParser: false) so we can raise the
  // limit above the 100kb default: an org logo is uploaded as a base64 data
  // URI (organizations.contract.ts caps logoUrl at ~2M chars ≈ ~2MB) until
  // logos move to object storage, and the default limit would 413 those.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
    ...(httpsOptions ? { httpsOptions } : {}),
  });
  app.useBodyParser('json', { limit: '3mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '3mb' });
  app.useLogger(app.get(Logger));
  // HSTS instructs browsers to only use TLS for this origin.
  app.use(helmet({ hsts: { maxAge: 15_552_000, includeSubDomains: true } }));
  app.use(cookieParser());
  app.setGlobalPrefix('api');

  const config = app.get(ConfigService);
  // Cookie session is httpOnly, so the frontend uses credentials:"include" —
  // that requires one explicit origin (never a wildcard) with credentials on.
  app.enableCors({ origin: config.corsOrigin, credentials: true });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  setupOpenApi(app);

  await app.listen(config.port);
}

void bootstrap();
