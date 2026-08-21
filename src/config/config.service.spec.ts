import { ConfigService } from './config.service';
import { validateEnv } from './env.schema';

const valid = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://cnap_owner:pw@localhost:5432/cnap',
  APP_DATABASE_URL: 'postgresql://cnap_app:pw@localhost:5432/cnap',
  SUPERVISOR_DATABASE_URL: 'postgresql://cnap_supervisor:pw@localhost:5432/cnap',
  JWT_SECRET: 'test_jwt_secret_at_least_32_chars_long_xx',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'a-real-32-byte-production-key!!!',
  LOG_LEVEL: 'info',
};

describe('validateEnv', () => {
  it('accepts a valid env and coerces PORT to a number', () => {
    const cfg = validateEnv(valid);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.APP_DATABASE_URL).toContain('cnap_app');
  });

  it('throws when a required var is missing', () => {
    const { APP_DATABASE_URL: _omit, ...rest } = valid;
    expect(() => validateEnv(rest)).toThrow(/APP_DATABASE_URL/);
  });

  it('requires SUPERVISOR_DATABASE_URL (runtime cross-org read creds)', () => {
    const { SUPERVISOR_DATABASE_URL: _omit, ...rest } = valid;
    expect(() => validateEnv(rest)).toThrow(/SUPERVISOR_DATABASE_URL/);
  });

  it('throws when NODE_ENV is not an allowed value', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'banana' })).toThrow(/NODE_ENV/);
  });

  it('requires DATABASE_URL (BackupService reads it at runtime for pg_dump)', () => {
    const { DATABASE_URL: _omit, ...rest } = valid;
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('defaults NODE_ENV to production when omitted (fail-safe)', () => {
    const { NODE_ENV: _omit, ...rest } = valid;
    const cfg = validateEnv(rest);
    expect(cfg.NODE_ENV).toBe('production');
  });

  it('requires distributed rate-limit storage in production', () => {
    const { REDIS_URL: _omit, ...rest } = valid;
    expect(() => validateEnv({ ...rest, NODE_ENV: 'production' })).toThrow(/REDIS_URL/);
  });

  it('rejects the default dev-only ENCRYPTION_KEY in production', () => {
    const { ENCRYPTION_KEY: _omit, ...rest } = valid;
    expect(() => validateEnv({ ...rest, NODE_ENV: 'production' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('accepts a real ENCRYPTION_KEY in production', () => {
    const cfg = validateEnv({ ...valid, NODE_ENV: 'production' });
    expect(cfg.ENCRYPTION_KEY).toBe(valid.ENCRYPTION_KEY);
  });
});

describe('ConfigService', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // Deliberately dropped rather than copied from ORIGINAL_ENV: this test
    // asserts the schema's *default* MAIL_FROM value, which only a real
    // developer machine's own .env (not CI) would otherwise leak in here,
    // making the test's pass/fail depend on whichever email address was
    // last configured locally instead of on the code under test.
    const { MAIL_FROM: _mailFrom, ...rest } = ORIGINAL_ENV;
    process.env = { ...rest };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  function makeConfig(overrides: Record<string, string> = {}): ConfigService {
    // Deliberately NOT spread over the inherited process.env: this file's
    // "safe defaults" assertions must hold in isolation from whatever the
    // developer's own .env happens to set (e.g. a real MAIL_FROM), otherwise
    // this test's outcome depends on the machine running it.
    process.env = { ...valid, ...overrides };
    return new ConfigService();
  }

  it('exposes CORS, Resend, and CSRF config with safe defaults', () => {
    const config = makeConfig({
      CORS_ORIGIN: 'http://localhost:3000',
      RESEND_API_KEY: 're_test_key',
    });
    expect(config.corsOrigin).toBe('http://localhost:3000');
    expect(config.resendApiKey).toBe('re_test_key');
    expect(config.mailFrom).toBe('RIO <no-reply@rio.local>');
    expect(config.csrfEnforce).toBe(true);
  });
});
