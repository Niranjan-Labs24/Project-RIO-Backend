import 'dotenv/config';
import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { ConfigService } from './config/config.service';
import { setupOpenApi } from './contract/openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.use(cookieParser());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  // The session cookie (see common/session.util.ts) is httpOnly, so the
  // frontend's fetch calls need credentials: "include" — that only works
  // cross-origin against one explicit, named origin, never a wildcard.
  app.enableCors({ origin: config.corsOrigin, credentials: true });
  // Matches the frontend's NEXT_PUBLIC_API_BASE_URL (.../api). /health stays
  // unprefixed for infra tooling/load balancers that probe it directly.
  app.setGlobalPrefix('api', { exclude: ['health', 'health/db'] });

  setupOpenApi(app);
  await app.listen(config.port);
}

void bootstrap();
