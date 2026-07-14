import { ForbiddenException } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';

function ctx(method: string, headers: Record<string, string>, cookies: Record<string, string>) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, headers, cookies }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as never;
}

// Reflector stub: returns `exempt` regardless of the (unused, in these tests)
// handler/class metadata keys — mirrors Reflector#getAllAndOverride's shape.
function reflectorStub(exempt: boolean) {
  return { getAllAndOverride: () => exempt } as never;
}

describe('CsrfGuard', () => {
  it('is a no-op when enforcement is disabled', () => {
    const guard = new CsrfGuard({ csrfEnforce: false } as never, reflectorStub(false));
    expect(guard.canActivate(ctx('POST', {}, {}))).toBe(true);
  });

  it('allows safe methods even when enforcing', () => {
    const guard = new CsrfGuard({ csrfEnforce: true } as never, reflectorStub(false));
    expect(guard.canActivate(ctx('GET', {}, {}))).toBe(true);
  });

  it('rejects an unsafe method with missing/mismatched token when enforcing', () => {
    const guard = new CsrfGuard({ csrfEnforce: true } as never, reflectorStub(false));
    expect(() => guard.canActivate(ctx('POST', {}, { rio_csrf: 'a' }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx('POST', { 'x-csrf-token': 'b' }, { rio_csrf: 'a' }))).toThrow(ForbiddenException);
  });

  it('allows an unsafe method when header matches cookie', () => {
    const guard = new CsrfGuard({ csrfEnforce: true } as never, reflectorStub(false));
    expect(guard.canActivate(ctx('POST', { 'x-csrf-token': 'a' }, { rio_csrf: 'a' }))).toBe(true);
  });

  it('allows an unsafe method with no CSRF cookie when the handler is @CsrfExempt (login/signup)', () => {
    const guard = new CsrfGuard({ csrfEnforce: true } as never, reflectorStub(true));
    expect(guard.canActivate(ctx('POST', {}, {}))).toBe(true);
  });

  it('still enforces a non-exempt unsafe route even when the reflector is consulted', () => {
    const guard = new CsrfGuard({ csrfEnforce: true } as never, reflectorStub(false));
    expect(() => guard.canActivate(ctx('POST', {}, {}))).toThrow(ForbiddenException);
  });
});
