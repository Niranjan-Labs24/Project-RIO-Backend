import { Type, type Static as TBStatic, type TSchema } from '@sinclair/typebox';

export const T = Type;
export type Static<S extends TSchema> = TBStatic<S>;
export type { TSchema };

const registry = new Map<string, TSchema>();

export function registerSchema<S extends TSchema>(name: string, schema: S): S {
  registry.set(name, schema);
  return schema;
}

export function getRegisteredSchemas(): Record<string, TSchema> {
  return Object.fromEntries(registry.entries());
}
