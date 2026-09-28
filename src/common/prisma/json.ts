import type { Prisma } from '../../generated/prisma';

/**
 * Prisma's JSON columns accept `InputJsonValue`, which our typed domain objects
 * (interfaces, class instances) are not assignable to even though they are
 * plain JSON. This is the one place that says so, instead of a double cast at
 * every write.
 */
export function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** The reverse: a JSON column read back as the domain type it was written from. */
export function fromJson<T>(value: unknown): T {
  return value as T;
}
