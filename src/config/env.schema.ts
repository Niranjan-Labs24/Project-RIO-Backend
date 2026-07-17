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
  // NOTE: DATABASE_URL (cnap_owner) is intentionally NOT part of the app's
  // schema. It's CLI-only (prisma.config.ts, seed, tests) and the running
  // app must never require or hold owner-role credentials. Extra env keys
  // (like DATABASE_URL) are ignored by ajv, so .env can still define it.
  APP_DATABASE_URL: Type.String({ minLength: 1 }),
  // Cross-org read-only connection (cnap_supervisor, NOBYPASSRLS). The running
  // app legitimately holds this at runtime for crossEntity roles' read path
  // (runAsSupervisor) — unlike DATABASE_URL (owner), which stays CLI-only.
  SUPERVISOR_DATABASE_URL: Type.String({ minLength: 1 }),
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
  // SMTP (nodemailer). When SMTP_HOST is unset the mailer is "not configured"
  // and signup falls back to the dev-only temp-password reveal.
  SMTP_HOST: Type.Optional(Type.String()),
  SMTP_PORT: Type.Number({ default: 587 }),
  SMTP_SECURE: Type.Boolean({ default: false }),
  SMTP_USER: Type.Optional(Type.String()),
  SMTP_PASS: Type.Optional(Type.String()),
  MAIL_FROM: Type.String({ default: 'RIO <no-reply@rio.local>' }),
  // Opt-in double-submit CSRF enforcement (see CsrfGuard). Default off:
  // requires the frontend to echo the rio_csrf cookie as X-CSRF-Token first.
  CSRF_ENFORCE: Type.Boolean({ default: false }),
  // RIO-FR-Add-01: local disk path evidence files are written to (Phase 1 —
  // swap to object storage later without touching the Evidence table, which
  // only stores a storageKey string).
  EVIDENCE_STORAGE_PATH: Type.String({ default: './storage/evidence' }),
  GEMINI_API_KEY: Type.Optional(Type.String()),
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
  return candidate as AppConfig;
}
