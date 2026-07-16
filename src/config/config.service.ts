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
  get tlsCertPath(): string | undefined {
    return this.config.TLS_CERT_PATH;
  }
  get tlsKeyPath(): string | undefined {
    return this.config.TLS_KEY_PATH;
  }
  get dbSsl(): boolean {
    return this.config.DB_SSL;
  }
  get dbSslRejectUnauthorized(): boolean {
    return this.config.DB_SSL_REJECT_UNAUTHORIZED;
  }
  get dbSslCaPath(): string | undefined {
    return this.config.DB_SSL_CA;
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
  get corsOrigin(): string {
    return this.config.CORS_ORIGIN;
  }
  get smtpHost(): string | undefined {
    return this.config.SMTP_HOST;
  }
  get smtpPort(): number {
    return this.config.SMTP_PORT;
  }
  get smtpSecure(): boolean {
    return this.config.SMTP_SECURE;
  }
  get smtpUser(): string | undefined {
    return this.config.SMTP_USER;
  }
  get smtpPass(): string | undefined {
    return this.config.SMTP_PASS;
  }
  get mailFrom(): string {
    return this.config.MAIL_FROM;
  }
  get csrfEnforce(): boolean {
    return this.config.CSRF_ENFORCE;
  }
  get evidenceStoragePath(): string {
    return this.config.EVIDENCE_STORAGE_PATH;
  }
}
