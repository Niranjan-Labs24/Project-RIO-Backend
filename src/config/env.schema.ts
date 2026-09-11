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
  // pg.Pool `max` for the two runtime pools (PrismaService / SupervisorPrismaService).
  // Undocumented pg default is 10 — far too small once every request (even a
  // read) opens its own interactive transaction for the per-request RLS org
  // context (see TenantPrismaService). Reproduced directly under real
  // concurrency: RIO-NFR-005's 2026-08-27 500-concurrent-session re-test
  // failed 94% of virtual users with "Unable to start a transaction in the
  // given time" once queueing exceeded Prisma's ~2s transaction maxWait.
  // Bounded above by Postgres's own max_connections, shared across both
  // pools plus migrations/admin/background-worker connections — raising
  // these does not substitute for right-sizing Postgres itself, and in a
  // multi-instance deployment each instance needs its own budget out of the
  // same shared ceiling (a connection pooler like PgBouncer is the real
  // production answer once there's more than one app instance).
  DB_POOL_MAX_APP: Type.Number({ default: 60, minimum: 1, maximum: 500 }),
  DB_POOL_MAX_SUPERVISOR: Type.Number({ default: 15, minimum: 1, maximum: 500 }),
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
  //
  // Two auth modes, checked in this order by SmsService:
  //   1. API Key   — TWILIO_ACCOUNT_SID + TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET.
  //      Preferred: a key is scoped and revocable without rotating the whole
  //      account. This is the shape the impetus.sa account issues (SK...).
  //   2. Auth Token — TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN. The account's
  //      root credential; kept as a fallback for environments that only have it.
  // TWILIO_FROM_NUMBER is required for SMS in BOTH modes — it is the SMS
  // sender (a Twilio-provisioned number in E.164, or a Messaging Service SID).
  // A verified *email* domain / from-address does not apply to SMS.
  TWILIO_ACCOUNT_SID: Type.Optional(Type.String()),
  TWILIO_API_KEY_SID: Type.Optional(Type.String()),
  TWILIO_API_KEY_SECRET: Type.Optional(Type.String()),
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
  // ── Which model provider AiService talks to ──────────────────────────
  //
  // 'oci_cohere' (the default) is Cohere Command A on OCI Generative AI in
  // me-riyadh-1, which keeps inference in-Kingdom — the same residency
  // question SEMANTIC_DUPLICATES_ENABLED below is waiting on, which is why
  // this is a deployment setting rather than a screen toggle.
  //
  // 'gemini' is the fallback, kept so a broken OCI tenancy (an expired API
  // key, a policy change, a region outage) is one env var away from being
  // worked around instead of a code change.
  //
  // An environment on the default still needs OCI_GENAI_API_KEY and
  // OCI_GENAI_COMPARTMENT_ID. Without them AI features log a warning and
  // fall back to manual mode — the same way a missing GEMINI_API_KEY has
  // always behaved — rather than failing startup. Run `npm run ai:oci-smoke`
  // in each environment to prove the tenancy before relying on it.
  //
  // Whichever is selected, every AI task stays provider-neutral — see
  // AiTask.responseSchema.
  AI_PROVIDER: Type.Union([Type.Literal('oci_cohere'), Type.Literal('gemini')], {
    default: 'oci_cohere',
  }),
  // OCI Generative AI service API key — the `sk-...` secret itself, NOT the
  // key's OCID. Sent as `Authorization: Bearer <key>`; no OCI request
  // signing is involved. A key only works in the region it was created in.
  OCI_GENAI_API_KEY: Type.Optional(Type.String()),
  // The compartment the model is called in. Required by the inference API
  // even when authenticating with an API key — a request without it is
  // rejected with "Compartment ID must be provided."
  OCI_GENAI_COMPARTMENT_ID: Type.Optional(Type.String()),
  // Region must match the region the API key was issued in, and is what
  // makes the residency claim true. me-riyadh-1 is in-Kingdom.
  OCI_GENAI_REGION: Type.String({ default: 'me-riyadh-1' }),
  OCI_GENAI_MODEL_ID: Type.String({ default: 'cohere.command-a-03-2025' }),
  // ON_DEMAND bills per request against a shared pool. DEDICATED routes to
  // a provisioned AI cluster and needs its own endpoint OCID as the model
  // id, so it is only worth setting once such a cluster exists.
  OCI_GENAI_SERVING_TYPE: Type.Union([Type.Literal('ON_DEMAND'), Type.Literal('DEDICATED')], {
    default: 'ON_DEMAND',
  }),
  // On-demand inference caps output at 4,000 tokens per run, so this is a
  // ceiling rather than a target. Tasks that need less say so themselves.
  OCI_GENAI_MAX_TOKENS: Type.Number({ default: 4000, minimum: 1, maximum: 4000 }),
  // ── Embeddings (RIO-AI-004 semantic duplicate detection) ─────────────
  //
  // A SEPARATE model from OCI_GENAI_MODEL_ID: Command A is a chat model and
  // cannot embed. This is the one Q10 actually rules on, because embedding is
  // what sends need text — including text written by members of the public —
  // out of the platform. Served from the same region, compartment and key, so
  // an in-Kingdom chat deployment stays in-Kingdom when it embeds.
  //
  // multilingual, not english: need titles and statements are Arabic and
  // English in the same table, and cross-language duplicate detection is the
  // entire reason the semantic pass exists — the literal pass scores an Arabic
  // need against its English twin at 0.000. embed-english-v3.0 would make this
  // feature no better than the pass it supplements.
  //
  // Verify both values with `npm run ai:oci-embed-smoke` before relying on
  // them: which models a tenancy serves ON_DEMAND varies by region, and the
  // script reports the width the model actually returns.
  OCI_GENAI_EMBED_MODEL_ID: Type.String({ default: 'cohere.embed-multilingual-v3.0' }),
  // Must match what the model returns; the adapter refuses a batch whose width
  // disagrees rather than storing vectors nothing can compare.
  //
  // Also matches need_embeddings.embedding's declared width — see migration
  // 20260911000000. A mismatch is not an error: SemanticDuplicateService
  // detects it and compares in the application instead of against the index.
  OCI_GENAI_EMBED_DIMENSIONS: Type.Number({ default: 1024, minimum: 1, maximum: 4096 }),
  // RIO-AI-004 / Q10 — the switch that lets need text leave the platform.
  //
  // Semantic duplicate detection embeds need titles and statements with an
  // external model. Until the client rules on in-Kingdom residency that is a
  // deployment decision, not a screen toggle, so it lives here and defaults
  // OFF: the code ships complete and inert until someone sets this.
  SEMANTIC_DUPLICATES_ENABLED: Type.Boolean({ default: false }),
  // Periodic pg_dump backup (BackupService). BACKUP_DIR is where dump files
  // are written (created if missing, relative paths resolved from the
  // process cwd). BACKUP_CRON_SCHEDULE is a standard 5-field cron
  // expression — NIGHTLY at 03:00, which is what the 24-hour RPO the client
  // confirmed under Q32 actually requires. It defaulted to weekly while the
  // mechanism was being proven end-to-end; leaving it there would have meant
  // a documented 24-hour RPO backed by a 7-day schedule.
  // ── Survey abandonment tracking + completion reminders (RPT10 Q-2) ──
  // How long a started-but-unsubmitted session may sit idle before it counts
  // as abandoned. A citizen survey is one sitting of a few minutes (see
  // SECONDS_PER_QUESTION in CitizenService), and the OTP itself expires after
  // 10 — 120 minutes is well past any realistic pause, so a session crossing
  // it is genuinely gone rather than slow. Configurable because a longer
  // survey may warrant a longer grace period; RPT10 prints the value it used.
  SURVEY_ABANDONMENT_IDLE_MINUTES: Type.Number({ default: 120, minimum: 5, maximum: 10_080 }),
  // Completion reminders. OFF by default: a reminder is an outbound message
  // to a citizen who did not finish, and no environment should start sending
  // those because it deployed a new build. Switch on per environment once the
  // client confirms the wording and the cadence.
  SURVEY_REMINDERS_ENABLED: Type.Boolean({ default: false }),
  // A reminder goes out well before the abandonment threshold — the point is
  // to recover the response, which means reaching the respondent while the
  // link is still on their phone, not after they are already counted as lost.
  SURVEY_REMINDER_IDLE_MINUTES: Type.Number({ default: 30, minimum: 5, maximum: 10_080 }),
  // Hard cap per session. Two nudges is the outer edge of helpful; beyond
  // that a respondent who stopped on purpose is being harassed.
  SURVEY_REMINDER_MAX: Type.Number({ default: 2, minimum: 0, maximum: 5 }),
  // Minimum gap between two reminders to the same session.
  SURVEY_REMINDER_COOLDOWN_MINUTES: Type.Number({ default: 1440, minimum: 30, maximum: 20_160 }),
  // Sweep cadence — classifies stale sessions as ABANDONED and sends any due
  // reminders. Standard 5-field cron; every 15 minutes by default.
  SURVEY_SESSION_SWEEP_CRON: Type.String({ default: '*/15 * * * *' }),
  BACKUP_DIR: Type.String({ default: './storage/backups' }),
  BACKUP_CRON_SCHEDULE: Type.String({ default: '0 3 * * *' }),
  // RIO-NFR-010 retention. How long a backup file is kept, and when the sweep
  // that deletes expired ones runs. The sweep has its own schedule rather than
  // riding the backup tick: a period with no backups is exactly when disk
  // pressure builds, so that is the worst time for pruning to also stop.
  //
  // 30 days is a starting value, not a client ruling. Q34 covers destination,
  // encryption and key custody; retention belongs with the same answer.
  BACKUP_RETENTION_DAYS: Type.Number({ default: 30 }),
  BACKUP_RETENTION_CRON: Type.String({ default: '30 4 * * *' }),
  // RIO-NFR-010 — the connection pg_dump uses.
  //
  // Separate from DATABASE_URL because a dump needs BYPASSRLS and the
  // application roles deliberately do not have it: 43 tables FORCE row-level
  // security, so pg_dump as cnap_owner fails outright ("query would be
  // affected by row-level security policy"). See
  // scripts/sql/nfr010-backup-role.sql, which provisions cnap_backup — SELECT
  // only, BYPASSRLS, nothing else.
  //
  // Optional so the app still boots without it; BackupService reports the
  // missing role in the failure it records rather than dumping the wrong
  // thing quietly.
  BACKUP_DATABASE_URL: Type.Optional(Type.String()),
  // RIO-NFR-010 / Q34 — encryption at rest for backup artefacts.
  //
  // Off unless set, deliberately. A backup encrypted with a key nobody has
  // escrowed is not a backup, it is a tidy way to lose data — so turning this
  // on is a decision taken together with deciding who holds the key, which is
  // exactly what Q34 asks. AES-256-GCM, key derived per file with scrypt.
  BACKUP_ENCRYPTION_KEY: Type.Optional(Type.String()),
  // Optional override for the pg_dump binary — the bare command name is
  // resolved via PATH by default, which is correct in Docker (see
  // Dockerfile) but can silently pick the wrong installed major version on
  // a host machine with multiple Postgres versions (e.g. Homebrew, where
  // `pg_dump` on PATH tracks whichever version is currently linked).
  PG_DUMP_PATH: Type.Optional(Type.String()),
  // RIO-NFR-010 — `pg_restore --list` reads a dump's table of contents for the
  // recoverability check. Same PATH caveat as PG_DUMP_PATH, and the same
  // version sensitivity: pg_restore refuses an archive written by a newer
  // major version, which would report a perfectly good backup as unreadable.
  PG_RESTORE_PATH: Type.Optional(Type.String()),
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
    [Type.Literal('fatal'), Type.Literal('error'), Type.Literal('warn'), Type.Literal('info')],
    { default: 'info' },
  ),
  SYSTEM_LOG_SAMPLE_RATE: Type.Number({ default: 0, minimum: 0, maximum: 1 }),
  // A 2xx slower than this is recorded anyway, as HTTP_SLOW — the one case
  // where a successful request is still an operational event.
  SYSTEM_LOG_SLOW_REQUEST_MS: Type.Number({ default: 3_000 }),
  SYSTEM_LOG_RETENTION_DAYS: Type.Number({ default: 90 }),
  SYSTEM_LOG_RETENTION_CRON: Type.String({ default: '0 3 * * *' }),
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
