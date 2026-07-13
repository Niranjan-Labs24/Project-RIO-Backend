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
  // Signs/verifies the session JWT issued by POST /auth/login and
  // /auth/signup (see auth.module.ts). No default — a weak or missing
  // secret must fail startup, not silently run with an insecure one.
  JWT_SECRET: Type.String({ minLength: 32 }),
  // The one browser origin allowed to send credentialed (cookie-bearing)
  // cross-origin requests — see main.ts's enableCors(). Backend keeps its
  // own default port (3000); the frontend dev server runs on 3001 instead
  // of contesting it — override this if your frontend runs elsewhere.
  CORS_ORIGIN: Type.String({ default: 'http://localhost:3001' }),
  // Resend API key for emailing the signup temporary password (see
  // MailerService). Optional and unset by default: without it, signup
  // falls back to its pre-mailer behavior (log + dev-only response field —
  // see AuthService.signup()) rather than failing. Get one free at
  // resend.com → API Keys. No minLength: docker-compose's `${VAR:-}`
  // interpolation sends an empty string, not an absent key, when unset —
  // MailerService already treats an empty string the same as undefined
  // (falsy check), so this just needs to accept it, not reject it.
  RESEND_API_KEY: Type.Optional(Type.String()),
  // Resend's shared test domain works with zero setup/verification; swap
  // to a verified domain once you have one — no code changes needed.
  MAIL_FROM: Type.String({ default: 'Rio <onboarding@resend.dev>' }),
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
