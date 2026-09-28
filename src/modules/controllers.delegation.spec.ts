import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { orgContext } from '../tenancy/org-context';

/**
 * Smoke test for the thin HTTP layer: every controller method is called once
 * with placeholder arguments against stand-in services. A handler must either
 * hand the work to a service or reject the input with an HTTP error — it must
 * not crash on the way. (Behaviour behind the services is covered by their own
 * specs, and route permissions by route-permission-inventory.spec.ts.)
 */
// Vite resolves import.meta.glob at build time; the TypeScript module setting here does not model it.
// @ts-expect-error -- Vite-only API
const modules = import.meta.glob('./**/*.controller.ts', { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

// RolesController.list serves the static role matrix, with no service behind it.
const SKIP = new Set(['constructor', 'RolesController.list']);
// Handlers normalise incoming strings; the stand-in answers those calls like a string would.
const STRING_METHODS = new Set([
  'trim',
  'toLowerCase',
  'toUpperCase',
  'slice',
  'substring',
  'replace',
  'startsWith',
  'endsWith',
]);

/** An object that accepts any call or property and records that it was used. */
function stub(record: { used: number }): unknown {
  const target = function () {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 'x';
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      if (prop === 'length') return 0;
      if (prop === 'split') return () => [];
      if (STRING_METHODS.has(prop)) return () => 'x';
      record.used++;
      return stub(record);
    },
    apply() {
      record.used++;
      return Promise.resolve(stub(record));
    },
    construct() {
      return stub(record) as object;
    },
  });
  return proxy;
}

const controllers: Array<[string, new (...args: unknown[]) => Record<string, unknown>]> = [];
for (const [file, mod] of Object.entries(modules)) {
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === 'function' && name.endsWith('Controller')) {
      controllers.push([`${file.replace('./', '')}:${name}`, value as never]);
    }
  }
}

function methodsOf(Ctor: new (...args: unknown[]) => Record<string, unknown>): string[] {
  return Object.getOwnPropertyNames(Ctor.prototype).filter(
    (m) =>
      !SKIP.has(m) &&
      !SKIP.has(`${Ctor.name}.${m}`) &&
      typeof (Ctor.prototype as Record<string, unknown>)[m] === 'function',
  );
}

describe('controllers', () => {
  it('finds the controllers', () => {
    expect(controllers.length).toBeGreaterThan(40);
  });

  const withMethods = controllers.filter(([, Ctor]) => methodsOf(Ctor).length > 0);

  describe.each(withMethods)('%s', (_label, Ctor) => {
    const methods = methodsOf(Ctor);

    it.each(methods)('%s hands work on or rejects the request', async (method) => {
      const record = { used: 0 };
      const paramTypes: unknown[] = Reflect.getMetadata('design:paramtypes', Ctor) ?? [];
      const controller = new Ctor(...paramTypes.map(() => stub(record)));
      const before = record.used;
      const args = Array.from({ length: 6 }, () => stub(record));
      let rejected = false;
      try {
        await orgContext.run(
          { requestId: 'r', orgId: 'org-1', actorId: 'u1', role: 'system_admin' },
          async () => (controller[method] as (...a: unknown[]) => unknown)(...args),
        );
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        rejected = true;
      }
      expect(rejected || record.used > before).toBe(true);
    });
  });
});
