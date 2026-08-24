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

  // Owner-role connection — see env.schema.ts's comment on DATABASE_URL for
  // why BackupService (and only BackupService) reads this at runtime.
  get databaseUrl(): string {
    return this.config.DATABASE_URL;
  }
  get appDatabaseUrl(): string {
    return this.config.APP_DATABASE_URL;
  }
  get supervisorDatabaseUrl(): string {
    return this.config.SUPERVISOR_DATABASE_URL;
  }
  get redisUrl(): string | undefined {
    return this.config.REDIS_URL;
  }
  get trustProxy(): string {
    return this.config.TRUST_PROXY;
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
  // RIO-NFR-006 — see env.schema.ts's DB_POOL_MAX comment.
  get dbPoolMax(): number {
    return this.config.DB_POOL_MAX;
  }
  get dbSupervisorPoolMax(): number {
    return this.config.DB_SUPERVISOR_POOL_MAX;
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
  // RIO-NFR-016 — see the SYSTEM_LOG_* block in env.schema.ts.
  get systemLogEnabled(): boolean {
    return this.config.SYSTEM_LOG_ENABLED;
  }
  get systemLogMinLevel(): AppConfig['SYSTEM_LOG_MIN_LEVEL'] {
    return this.config.SYSTEM_LOG_MIN_LEVEL;
  }
  get systemLogSampleRate(): number {
    return this.config.SYSTEM_LOG_SAMPLE_RATE;
  }
  get systemLogSlowRequestMs(): number {
    return this.config.SYSTEM_LOG_SLOW_REQUEST_MS;
  }
  get systemLogRetentionDays(): number {
    return this.config.SYSTEM_LOG_RETENTION_DAYS;
  }
  get systemLogRetentionCron(): string {
    return this.config.SYSTEM_LOG_RETENTION_CRON;
  }
  get corsOrigin(): string {
    return this.config.CORS_ORIGIN;
  }
  // See the PUBLIC_APP_URL comment in env.schema.ts — the citizen-facing
  // base URL, distinct from (but defaulting to) CORS_ORIGIN.
  get publicAppUrl(): string {
    return this.config.PUBLIC_APP_URL ?? this.config.CORS_ORIGIN;
  }
  get resendApiKey(): string | undefined {
    return this.config.RESEND_API_KEY;
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
  get reviewerSlaHours(): number {
    return this.config.REVIEWER_SLA_HOURS;
  }
  get reviewerSlaPollIntervalMs(): number {
    return this.config.REVIEWER_SLA_POLL_INTERVAL_MS;
  }
  get geminiApiKey(): string | undefined {
    return this.config.GEMINI_API_KEY;
  }
  get twilioAccountSid(): string | undefined {
    return this.config.TWILIO_ACCOUNT_SID;
  }
  get twilioAuthToken(): string | undefined {
    return this.config.TWILIO_AUTH_TOKEN;
  }
  get twilioFromNumber(): string | undefined {
    return this.config.TWILIO_FROM_NUMBER;
  }
  get smsTimeoutMs(): number {
    return this.config.SMS_TIMEOUT_MS;
  }
  get backupDir(): string {
    return this.config.BACKUP_DIR;
  }
  get backupCronSchedule(): string {
    return this.config.BACKUP_CRON_SCHEDULE;
  }
  get pgDumpPath(): string | undefined {
    return this.config.PG_DUMP_PATH;
  }
  // RIO-NFR-002 / AD-17 — AES-256-GCM key for citizen PII encryption at rest.
  get encryptionKey(): string {
    return this.config.ENCRYPTION_KEY;
  }
  // GAP-03 / AD-17 — separate keyed-HMAC key for the PII blind index
  // (dedup/uniqueness on the now-nondeterministic GCM ciphertext columns).
  // Deliberately distinct from encryptionKey — see env.schema.ts.
  get blindIndexKey(): string {
    return this.config.PII_BLIND_INDEX_KEY;
  }
  get citizenPiiRetentionDays(): number {
    return this.config.CITIZEN_PII_RETENTION_DAYS;
  }
  get citizenPiiRetentionCron(): string {
    return this.config.CITIZEN_PII_RETENTION_CRON;
  }
  // GAP-02 — see the AUDIT_CHECKPOINT_CRON/AUDIT_SIGNING_KEY block in
  // env.schema.ts.
  get auditCheckpointCron(): string {
    return this.config.AUDIT_CHECKPOINT_CRON;
  }
  get auditSigningKey(): string {
    return this.config.AUDIT_SIGNING_KEY;
  }
}
