import { BadRequestException } from '@nestjs/common';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(field: string, rule: string): BadRequestException {
  return new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: `${field} ${rule}` } });
}

/** Optional free text with an upper bound. `undefined`/`null` pass through as `undefined`. */
export function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(field, 'must be a string');
  if (value.length > maxLength) throw invalid(field, `must be at most ${maxLength} characters`);
  return value;
}

/** A body value that must be a real boolean (never coerced from a string). */
export function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalid(field, 'must be a boolean');
  return value;
}

/** An optional UUID string. `undefined`/`null` pass through as `undefined`. */
export function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw invalid(field, 'must be a valid UUID');
  return value;
}

/** A list of UUID strings with an upper bound on its length. */
export function uuidList(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value)) throw invalid(field, 'must be an array');
  if (value.length > maxItems) throw invalid(field, `must have at most ${maxItems} items`);
  for (const item of value) {
    if (typeof item !== 'string' || !UUID_PATTERN.test(item)) throw invalid(field, 'must contain only valid UUIDs');
  }
  return value as string[];
}

/** Parses a date query parameter; anything that is not a real date is a 400, not an Invalid Date passed to the database. */
export function parseDateParam(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid(field, 'must be a valid date');
  return date;
}

/** Every listed field, when present, must be a string within its length limit. */
export function boundedStrings(body: object | undefined, limits: Record<string, number>): void {
  const record = (body ?? {}) as Record<string, unknown>;
  for (const [field, max] of Object.entries(limits)) {
    optionalText(record[field], field, max);
  }
}

/** Free text that may also be `null` (to clear a value); `undefined` means "leave as is". */
export function nullableText(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === null) return null;
  return optionalText(value, field, maxLength);
}

/** A JSON object body of bounded serialized size (for the free-form summary edits). */
export function boundedJsonObject<T extends object>(value: unknown, field: string, maxBytes: number): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(field, 'must be a JSON object');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) throw invalid(field, `must be at most ${maxBytes} bytes`);
  return value as T;
}
