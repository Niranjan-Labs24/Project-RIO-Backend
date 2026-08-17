import { Type, type Static } from '@sinclair/typebox';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export const EnvSchema = Type.Object({
  // Fail-safe default: an unset NODE_ENV must behave as production (the
  // strictest, most locked-down mode) rather than opening dev-only seams
  // (e.g. the x-org-id header trust in OrgContextMiddleware). A build that
  // forgets to set NODE_ENV should fail closed, not fail open.
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
    { default: 'production' },
  ),
  PORT: Type.Number({ default: 3000 }),
  // Owner role (cnap_owner) — historically CLI-only (prisma.config.ts,
  // seed, tests). Now also read at runtime by BackupService: pg_dump needs
  // a connection that bypasses RLS to produce a complete backup, and
  // APP_DATABASE_URL/SUPERVISOR_DATABASE_URL below are both NOBYPASSRLS —
  // using either would silently dump an incomplete (or empty) database
  // instead of failing loudly. This is a deliberate, confirmed exception to
  // "the app never holds owner creds," made specifically for the backup
  // job rather than introducing a separate backup-only DB role.
  DATABASE_URL: Type.String({ minLength: 1 }),
  APP_DATABASE_URL: Type.String({ minLength: 1 }),
  // Cross-org read-only connection (cnap_supervisor, NOBYPASSRLS). The running
  // app legitimately holds this at runtime for crossEntity roles' read path
  // (runAsSupervisor) — unlike DATABASE_URL (owner), which stays CLI-only.
  SUPERVISOR_DATABASE_URL: Type.String({ minLength: 1 }),
  REDIS_URL: Type.Optional(Type.String({ minLength: 1 })),
  TRUST_PROXY: Type.String({ default: 'loopback' }),
  // JWT signing secret for stateless bearer auth (min 32 chars). Required at
  // runtime — the app issues/verifies its own session tokens.
  JWT_SECRET: Type.String({ minLength: 32 }),
  JWT_EXPIRES_IN: Type.String({ default: '12h' }),
  // TLS (encryption in transit, RIO-NFR-001). Optional: when both are set the
  // app serves HTTPS directly; otherwise it serves HTTP and TLS is expected to
  // be terminated at an ingress/reverse proxy in front of it.
  TLS_CERT_PATH: Type.Optional(Type.String()),
  TLS_KEY_PATH: Type.Optional(Type.String()),
  // When true, the app connects to Postgres over TLS (self-signed accepted).
  DB_SSL: Type.Boolean({ default: false }),
  // Verify the Postgres server certificate. Defaults to false (dev self-signed);
  // set true in production to authenticate the DB and defeat MITM.
  DB_SSL_REJECT_UNAUTHORIZED: Type.Boolean({ default: false }),
  // Optional CA/chain PEM path to trust when verifying a non-system-CA cert.
  DB_SSL_CA: Type.Optional(Type.String()),
  // Frontend origin allowed to send credentialed (cookie) requests. Single
  // explicit origin — credentials mode forbids a wildcard.
  CORS_ORIGIN: Type.String({ default: 'http://localhost:3000' }),
  // Public-facing base URL citizens actually load in their browser (what a
  // scanned QR code should point at). Deliberately separate from
  // CORS_ORIGIN: CORS_ORIGIN is "which origin may call this API", not
  // "where the public app is served from" — they happen to coincide in
  // most single-frontend deployments, but conflating them would break the
  // day the public survey is served from its own subdomain/CDN. Defaults to
  // CORS_ORIGIN so existing dev/staging setups keep working without a new
  // env var, but should be set explicitly in any real environment.
  PUBLIC_APP_URL: Type.Optional(Type.String()),
  // Resend (email API — see MailerService). When RESEND_API_KEY is unset the
  // mailer is "not configured" and signup falls back to the dev-only
  // temp-password reveal.
  RESEND_API_KEY: Type.Optional(Type.String()),
  MAIL_FROM: Type.String({ default: 'RIO <no-reply@rio.local>' }),
  // Twilio (SMS OTP delivery for the citizen public survey flow — see
  // SmsService). When TWILIO_ACCOUNT_SID is unset the SMS channel is "not
  // configured", same not-configured/soft-fail convention as Resend above —
  // a mobile number just won't get a text until these are set.
  TWILIO_ACCOUNT_SID: Type.Optional(Type.String()),
  TWILIO_AUTH_TOKEN: Type.Optional(Type.String()),
  TWILIO_FROM_NUMBER: Type.Optional(Type.String()),
  // Bounds every outbound Twilio API call (SmsService) — the Twilio SDK's
  // own default is 30s, which is too long to leave a citizen's OTP request
  // hanging on a slow/unresponsive provider. 10s is a conservative default;
  // override per environment if Twilio's own latency profile warrants it.
  SMS_TIMEOUT_MS: Type.Number({ default: 10_000, minimum: 1000, maximum: 60_000 }),
  // Double-submit CSRF enforcement for cookie-authenticated mutations. Default
  // on; bearer and anonymous requests do not carry ambient session authority.
  CSRF_ENFORCE: Type.Boolean({ default: true }),
  // RIO-FR-Add-01: local disk path evidence files are written to (Phase 1 —
  // swap to object storage later without touching the Evidence table, which
  // only stores a storageKey string).
  EVIDENCE_STORAGE_PATH: Type.String({ default: './storage/evidence' }),
  // Reviewer SLA alerts: how long a pending human-review item has before
  // it's "at risk"/"breached", and how often the frontend should poll for
  // alerts — both configurable per RIO-NFR-014, not hardcoded constants.
  REVIEWER_SLA_HOURS: Type.Number({ default: 48 }),
  REVIEWER_SLA_POLL_INTERVAL_MS: Type.Number({ default: 60_000 }),
  GEMINI_API_KEY: Type.Optional(Type.String()),
  // Periodic pg_dump backup (BackupService). BACKUP_DIR is where dump files
  // are written (created if missing, relative paths resolved from the
  // process cwd). BACKUP_CRON_SCHEDULE is a standard 5-field cron
  // expression — defaults to weekly (Sundays at 03:00), confirmed working
  // end-to-end during testing at a faster interval first.
  BACKUP_DIR: Type.String({ default: './storage/backups' }),
  BACKUP_CRON_SCHEDULE: Type.String({ default: '0 3 * * 0' }),
  // Optional override for the pg_dump binary — the bare command name is
  // resolved via PATH by default, which is correct in Docker (see
  // Dockerfile) but can silently pick the wrong installed major version on
  // a host machine with multiple Postgres versions (e.g. Homebrew, where
  // `pg_dump` on PATH tracks whichever version is currently linked).
  PG_DUMP_PATH: Type.Optional(Type.String()),
  // RIO-NFR-016 — persisted operational log (system_logs).
  //
  // SYSTEM_LOG_ENABLED is a master kill switch: false turns
  // SystemLogsService.record() into a no-op, leaving the pino/stdout
  // pipeline completely untouched. SYSTEM_LOG_MIN_LEVEL gates what is worth
  // a table row (stdout keeps everything at LOG_LEVEL).
  //
  // SYSTEM_LOG_SAMPLE_RATE defaults to 0 deliberately: persisting every
  // successful request would add millions of rows a month for no
  // diagnostic value. Errors, warnings and slow requests are never sampled
  // — they are always recorded regardless of this setting.
  SYSTEM_LOG_ENABLED: Type.Boolean({ default: true }),
  SYSTEM_LOG_MIN_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
    ],
    { default: 'info' },
  ),
  SYSTEM_LOG_SAMPLE_RATE: Type.Number({ default: 0, minimum: 0, maximum: 1 }),
  // A 2xx slower than this is recorded anyway, as HTTP_SLOW — the one case
  // where a successful request is still an operational event.
  SYSTEM_LOG_SLOW_REQUEST_MS: Type.Number({ default: 3_000 }),
  SYSTEM_LOG_RETENTION_DAYS: Type.Number({ default: 90 }),
  SYSTEM_LOG_RETENTION_CRON: Type.String({ default: '0 3 * * *' }),
  // RIO-NFR-002 — citizen PII (SurveyResponse.contact/mobile) is encrypted
  // at rest using AES-256-CBC with this key. Must be exactly 32 bytes
  // (256 bits). Required in production; defaults to a dev-only placeholder
  // so existing dev/test setups continue without change. NEVER use the
  // default in staging or production.
  ENCRYPTION_KEY: Type.String({ default: 'dev-only-32-byte-placeholder-key!', minLength: 32 }),
  // How many days citizen contact PII (contact email, mobile) is retained on
  // SurveyResponse rows before being nullified by CitizenPiiRetentionService.
  CITIZEN_PII_RETENTION_DAYS: Type.Number({ default: 90, minimum: 1 }),
  CITIZEN_PII_RETENTION_CRON: Type.String({ default: '0 2 * * *' }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
    ],
    { default: 'info' },
  ),
});

export type AppConfig = Static<typeof EnvSchema>;

const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true });
addFormats(ajv);
const validate = ajv.compile(EnvSchema);

export function validateEnv(raw: Record<string, unknown>): AppConfig {
  const candidate: Record<string, unknown> = { ...raw };
  const ok = validate(candidate);
  if (!ok) {
    const details = (validate.errors ?? [])
      .map((e) => `${e.instancePath || e.params?.['missingProperty'] || ''} ${e.message}`.trim())
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  if (candidate.NODE_ENV === 'production' && !candidate.REDIS_URL) {
    throw new Error('Invalid environment configuration: REDIS_URL is required in production');
  }
  return candidate as AppConfig;
}
