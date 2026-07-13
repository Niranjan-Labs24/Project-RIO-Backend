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
