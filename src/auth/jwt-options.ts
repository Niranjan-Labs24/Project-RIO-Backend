import type { JwtModuleOptions } from '@nestjs/jwt';

/**
 * Session-token settings, shared by the application module and its tests.
 *
 * The algorithm is pinned on both sides: tokens are signed with HS256 and only
 * HS256 is accepted on verify, so a token signed with any other algorithm
 * (including "none") is rejected regardless of what the key material allows.
 */
export function buildJwtOptions(secret: string, expiresIn: string): JwtModuleOptions {
  return {
    secret,
    // `expiresIn` wants ms's StringValue template-literal type; the env value is
    // validated as a string (e.g. '12h') and safe to pass through.
    signOptions: { expiresIn: expiresIn as unknown as number, algorithm: 'HS256' },
    verifyOptions: { algorithms: ['HS256'] },
  };
}
