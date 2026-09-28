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
import { SystemLogsService } from './modules/system-logs/system-logs.service';
import { validateEnv } from './config/env.schema';
import { buildHttpsOptions } from './config/https-options';
import { setupOpenApi } from './contract/openapi';

async function bootstrap(): Promise<void> {
  // Encryption in transit (RIO-NFR-001): serve HTTPS directly when a cert/key
  // are configured; otherwise HTTP (TLS terminated by an ingress/proxy).
  const startupEnv = validateEnv(process.env);
  const httpsOptions = buildHttpsOptions(startupEnv.TLS_CERT_PATH, startupEnv.TLS_KEY_PATH);
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
  app.set('trust proxy', config.trustProxy);
  // Cookie session is httpOnly, so the frontend uses credentials:"include" —
  // that requires one explicit origin (never a wildcard) with credentials on.
  // exposedHeaders: Content-Disposition isn't readable via fetch() cross-origin
  // by default — the Reports export download (ReportsService.download) needs
  // it to recover the real filename instead of falling back to a generic one.
  app.enableCors({ origin: config.corsOrigin, credentials: true, exposedHeaders: ['Content-Disposition'] });

  // RIO-NFR-016 — the filter is constructed by hand (it always has been),
  // so the operational-log recorder is handed to it explicitly rather than
  // injected. `undefined` keeps its default stdout logger; the second
  // argument is what makes 4xx/5xx queryable in system_logs.
  const systemLogs = app.get(SystemLogsService);
  app.useGlobalFilters(new AllExceptionsFilter(undefined, systemLogs));
  app.enableShutdownHooks();
  // SEC-004 — the route map is only published outside production.
  if (config.nodeEnv !== 'production') setupOpenApi(app);

  await app.listen(config.port);

  systemLogs.record({
    level: 'info',
    category: 'startup',
    source: 'bootstrap',
    eventCode: 'APP_STARTED',
    message: `API listening on port ${config.port}`,
    context: { port: config.port, nodeEnv: config.nodeEnv, https: Boolean(httpsOptions) },
  });

  // RIO-NFR-001 / RIO-NFR-010 (28 Sep 2026) — these were previously silent
  // gaps: a production deployment could run indefinitely with an unencrypted
  // DB connection or a backup role nobody configured, and nothing would say
  // so until someone needed the thing that wasn't there. Deliberately a
  // WARNING here, not a startup failure like REDIS_URL's check in
  // validateEnv: we cannot verify from here whether an already-running
  // production deployment has these set, and a hard failure on a variable
  // that used to be optional would turn an unrelated code change into an
  // outage on its next restart. This makes the gap loud and queryable
  // (system_logs) instead of closing it outright — actually closing it needs
  // real infrastructure decisions (a TLS-capable DB, an off-host destination,
  // who holds the encryption key) that only the deployment owner can make.
  if (config.nodeEnv === 'production') {
    if (!config.dbSsl || !config.dbSslRejectUnauthorized) {
      const message =
        'Production is running without a verified TLS connection to the database ' +
        '(DB_SSL and DB_SSL_REJECT_UNAUTHORIZED should both be true). Data in transit ' +
        'to the database is not protected against interception, and the server ' +
        'identity is not being checked.';
      systemLogs.record({
        level: 'warn',
        category: 'security',
        source: 'bootstrap',
        eventCode: 'PRODUCTION_DB_TLS_NOT_ENFORCED',
        message,
      });
    }
    if (!config.backupDatabaseUrl) {
      const message =
        'Production has no BACKUP_DATABASE_URL configured. Scheduled database backups ' +
        'will fail every time they run (row-level security blocks the default DB role ' +
        'from reading tenant data) until this is set — see docs/dr-runbook.md.';
      systemLogs.record({
        level: 'warn',
        category: 'job',
        source: 'bootstrap',
        eventCode: 'PRODUCTION_BACKUP_DATABASE_URL_MISSING',
        message,
      });
    }
    if (!config.backupEncryptionKey) {
      const message =
        'Production has no BACKUP_ENCRYPTION_KEY configured. Database and attachment ' +
        'backups are being written to disk unencrypted — see docs/dr-runbook.md before ' +
        'deciding this is acceptable for real tenant data.';
      systemLogs.record({
        level: 'warn',
        category: 'security',
        source: 'bootstrap',
        eventCode: 'PRODUCTION_BACKUP_NOT_ENCRYPTED',
        message,
      });
    }
  }
}

void bootstrap();
