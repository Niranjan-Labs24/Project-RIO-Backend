import { ForbiddenException } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';

function ctx(method: string, headers: Record<string, string>, cookies: Record<string, string>) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, headers, cookies }) }),
  } as never;
}

describe('CsrfGuard', () => {
  it('is a no-op when enforcement is disabled', () => {
    const guard = new CsrfGuard({ csrfEnforce: false } as never);
    expect(guard.canActivate(ctx('POST', {}, {}))).toBe(true);
  });

  it('allows safe methods even when enforcing', () => {
    const guard = new CsrfGuard({ csrfEnforce: true } as never);
    expect(guard.canActivate(ctx('GET', {}, {}))).toBe(true);
  });

  it('rejects an unsafe method with missing/mismatched token when enforcing', () => {
    const guard = new CsrfGuard({ csrfEnforce: true } as never);
    expect(() => guard.canActivate(ctx('POST', {}, { rio_csrf: 'a' }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx('POST', { 'x-csrf-token': 'b' }, { rio_csrf: 'a' }))).toThrow(ForbiddenException);
  });

  it('allows an unsafe method when header matches cookie', () => {
    const guard = new CsrfGuard({ csrfEnforce: true } as never);
    expect(guard.canActivate(ctx('POST', { 'x-csrf-token': 'a' }, { rio_csrf: 'a' }))).toBe(true);
  });
});
