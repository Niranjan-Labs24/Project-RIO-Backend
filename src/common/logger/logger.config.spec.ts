import { describe, expect, it } from 'vitest';
import { orgContext } from '../../tenancy/org-context';
import { buildLoggerConfig } from './logger.config';

/**
 * RIO-NFR-016 — operational logs have to be queryable, which in practice
 * means every line (not just pino-http's own request/response lines) can be
 * joined back to the request and tenant it belongs to.
 *
 * `mixin` is what delivers that: pino calls it for every log line on the
 * logger and all its children, so an error logged from inside a service
 * carries the same requestId as the request line for that request. Before
 * it, only `customProps` was set — and pino-http applies that to its own two
 * lines alone, so service-level errors (failed emails, AI classification
 * failures, import errors) came out with no correlation at all.
 */
describe('buildLoggerConfig (RIO-NFR-016)', () => {
  const pinoHttp = () => buildLoggerConfig('info').pinoHttp as {
    level: string;
    mixin: () => Record<string, unknown>;
    customProps: () => Record<string, unknown>;
    redact: { paths: string[]; remove: boolean };
    autoLogging: boolean;
  };

  it('stamps requestId and orgId on every line via mixin, not just request lines', () => {
    const store = { requestId: 'req-1', orgId: 'org-1' };
    const stamped = orgContext.run(store, () => pinoHttp().mixin());

    expect(stamped).toEqual({ requestId: 'req-1', orgId: 'org-1' });
  });

  it('stamps the request lines too, so both agree on the correlation id', () => {
    const store = { requestId: 'req-1', orgId: 'org-1' };
    const config = pinoHttp();
    const fromMixin = orgContext.run(store, () => config.mixin());
    const fromCustomProps = orgContext.run(store, () => config.customProps());

    expect(fromMixin).toEqual(fromCustomProps);
  });

  it('omits orgId before tenant context is established, rather than inventing one', () => {
    // A pre-auth request (login, signup, the public consent endpoint) has a
    // requestId but no org yet — the line must still be correlatable.
    const stamped = orgContext.run({ requestId: 'req-2' }, () => pinoHttp().mixin());

    expect(stamped.requestId).toBe('req-2');
    expect(stamped.orgId).toBeUndefined();
  });

  it('emits no correlation keys at all outside a request', () => {
    // Startup, shutdown and scheduled jobs run with no store. pino drops
    // undefined values, so these lines stay clean instead of carrying
    // `"requestId": null` noise that a log query would have to filter out.
    const stamped = pinoHttp().mixin();

    expect(stamped.requestId).toBeUndefined();
    expect(stamped.orgId).toBeUndefined();
  });

  it('redacts credential-bearing headers and never enables body logging', () => {
    const { redact, autoLogging, level } = pinoHttp();

    expect(redact.paths).toEqual([
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-org-id"]',
    ]);
    // `remove` (not a mask) — the values must not reach the log at all.
    expect(redact.remove).toBe(true);
    expect(autoLogging).toBe(true);
    expect(level).toBe('info');
  });

  it('logs only id/method/url from the request, never headers or body', () => {
    const config = buildLoggerConfig('info').pinoHttp as {
      serializers: { req: (r: unknown) => Record<string, unknown> };
    };
    const serialized = config.serializers.req({
      id: 'r1',
      method: 'POST',
      url: '/api/auth/login',
      headers: { authorization: 'Bearer secret' },
      body: { password: 'hunter2' },
    });

    expect(serialized).toEqual({ id: 'r1', method: 'POST', url: '/api/auth/login' });
    expect(serialized.body).toBeUndefined();
    expect(serialized.headers).toBeUndefined();
  });
});
