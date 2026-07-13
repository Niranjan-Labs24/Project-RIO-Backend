import { validateEnv } from './env.schema';

const valid = {
  NODE_ENV: 'development',
  PORT: '3000',
  APP_DATABASE_URL: 'postgresql://cnap_app:pw@localhost:5432/cnap',
  SUPERVISOR_DATABASE_URL: 'postgresql://cnap_supervisor:pw@localhost:5432/cnap',
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

  it('does not require DATABASE_URL (owner creds are CLI-only, not app config)', () => {
    const { DATABASE_URL: _omit, ...rest } = { ...valid, DATABASE_URL: 'ignored' };
    expect(() => validateEnv(rest)).not.toThrow();
  });

  it('ignores an extra DATABASE_URL key if present in the environment', () => {
    const cfg = validateEnv({ ...valid, DATABASE_URL: 'postgresql://cnap_owner:pw@localhost:5432/cnap' });
    expect(cfg.APP_DATABASE_URL).toContain('cnap_app');
  });

  it('defaults NODE_ENV to production when omitted (fail-safe)', () => {
    const { NODE_ENV: _omit, ...rest } = valid;
    const cfg = validateEnv(rest);
    expect(cfg.NODE_ENV).toBe('production');
  });
});
