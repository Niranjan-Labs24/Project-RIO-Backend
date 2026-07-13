import { Injectable } from '@nestjs/common';
import { validateEnv, type AppConfig } from './env.schema';

@Injectable()
export class ConfigService {
  private readonly config: AppConfig;

  constructor() {
    this.config = validateEnv(process.env as Record<string, unknown>);
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key];
  }

  get appDatabaseUrl(): string {
    return this.config.APP_DATABASE_URL;
  }
  get supervisorDatabaseUrl(): string {
    return this.config.SUPERVISOR_DATABASE_URL;
  }
  get jwtSecret(): string {
    return this.config.JWT_SECRET;
  }
  get jwtExpiresIn(): string {
    return this.config.JWT_EXPIRES_IN;
  }
  get port(): number {
    return this.config.PORT;
  }
  get nodeEnv(): AppConfig['NODE_ENV'] {
    return this.config.NODE_ENV;
  }
  get logLevel(): AppConfig['LOG_LEVEL'] {
    return this.config.LOG_LEVEL;
  }
}
