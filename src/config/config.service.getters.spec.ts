import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from './config.service';

const env = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://cnap_owner:pw@localhost:5432/cnap',
  APP_DATABASE_URL: 'postgresql://cnap_app:pw@localhost:5432/cnap',
  SUPERVISOR_DATABASE_URL: 'postgresql://cnap_supervisor:pw@localhost:5432/cnap',
  JWT_SECRET: 'test_jwt_secret_at_least_32_chars_long_xx',
};

describe('ConfigService getters', () => {
  const saved = { ...process.env };
  beforeAll(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  });
  afterAll(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('reads every typed setting without throwing, with defaults applied', () => {
    const config = new ConfigService();
    const proto = Object.getPrototypeOf(config) as object;
    const names = Object.entries(Object.getOwnPropertyDescriptors(proto))
      .filter(([, d]) => typeof d.get === 'function')
      .map(([name]) => name);
    expect(names.length).toBeGreaterThan(30);
    const values: Record<string, unknown> = {};
    for (const name of names) {
      expect(() => {
        values[name] = (config as unknown as Record<string, unknown>)[name];
      }, name).not.toThrow();
    }
    expect(values.nodeEnv).toBe('development');
    expect(values.databaseUrl).toContain('cnap_owner');
    expect(values.appDatabaseUrl).toContain('cnap_app');
    expect(values.supervisorDatabaseUrl).toContain('cnap_supervisor');
    expect(values.jwtExpiresIn).toBe('12h');
    expect(values.port ?? 3000).toBe(3000);
  });

  it('exposes the raw value for any key', () => {
    const config = new ConfigService();
    expect(config.get('NODE_ENV')).toBe('development');
    expect(config.get('INSTANCE_ID')).toBeUndefined();
  });
});
