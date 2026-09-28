import { vi } from 'vitest';

type Fn = ReturnType<typeof vi.fn>;

/**
 * A stand-in for a Prisma client / transaction: every `tx.model.method` is a
 * cached vi.fn() created on first use, so a spec only stubs what it reads.
 * `findMany` resolves to [] and `count` to 0 until a spec says otherwise.
 * Typed loosely on purpose — indexing can never be undefined here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FakeTx = any;

export function makeFakeTx(extras: Record<string, unknown> = {}): FakeTx {
  const models = new Map<string, Record<string, Fn>>();
  return new Proxy({} as Record<string, Record<string, Fn>>, {
    get(_target, model: string) {
      if (model in extras) return extras[model];
      if (!models.has(model)) {
        const methods = new Map<string, Fn>();
        models.set(
          model,
          new Proxy({} as Record<string, Fn>, {
            get(_m, method: string) {
              if (!methods.has(method)) {
                methods.set(
                  method,
                  vi
                    .fn()
                    .mockResolvedValue(
                      method === 'findMany' ? [] : method === 'count' ? 0 : undefined,
                    ),
                );
              }
              return methods.get(method)!;
            },
          }),
        );
      }
      return models.get(model)!;
    },
  });
}
