import { describe, expect, it } from 'vitest';
import { boundedJsonObject, boundedStrings, nullableText, optionalText, optionalUuid, requiredBoolean, uuidList } from './bounded';

const ID = '01a0d7dc-0c02-7d28-9309-76e7cb292391';

/** The VALIDATION_ERROR envelope's message for a call that must reject. */
function rejection(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    const body = (err as { getResponse?: () => { error: { code: string; message: string } } }).getResponse?.();
    expect(body?.error.code).toBe('VALIDATION_ERROR');
    return body?.error.message ?? '';
  }
  throw new Error('expected the call to reject');
}

describe('optionalText', () => {
  it('passes undefined, null and normal text through unchanged', () => {
    expect(optionalText(undefined, 'reason', 10)).toBeUndefined();
    expect(optionalText(null, 'reason', 10)).toBeUndefined();
    expect(optionalText('ok', 'reason', 10)).toBe('ok');
    expect(optionalText('x'.repeat(10), 'reason', 10)).toHaveLength(10);
  });
  it('rejects non-strings and over-long text with VALIDATION_ERROR', () => {
    expect(rejection(() => optionalText(5, 'reason', 10))).toMatch(/must be a string/);
    expect(rejection(() => optionalText('x'.repeat(11), 'reason', 10))).toMatch(/at most 10/);
  });
});

describe('requiredBoolean', () => {
  it('accepts only real booleans - the string "false" is not coerced to true', () => {
    expect(requiredBoolean(true, 'isIncluded')).toBe(true);
    expect(requiredBoolean(false, 'isIncluded')).toBe(false);
    expect(rejection(() => requiredBoolean('false', 'isIncluded'))).toMatch(/boolean/);
    expect(rejection(() => requiredBoolean(undefined, 'isIncluded'))).toMatch(/boolean/);
  });
});

describe('optionalUuid / uuidList', () => {
  it('validates UUIDs and lengths', () => {
    expect(optionalUuid(undefined, 'id')).toBeUndefined();
    expect(optionalUuid(ID, 'id')).toBe(ID);
    expect(rejection(() => optionalUuid('nope', 'id'))).toMatch(/valid UUID/);
    expect(uuidList([ID, ID], 'ids', 5)).toHaveLength(2);
    expect(rejection(() => uuidList('x', 'ids', 5))).toMatch(/array/);
    expect(rejection(() => uuidList([ID, 'bad'], 'ids', 5))).toMatch(/valid UUIDs/);
    expect(rejection(() => uuidList([ID, ID, ID], 'ids', 2))).toMatch(/at most 2/);
  });
});

import { parseDateParam } from './bounded';

describe('parseDateParam', () => {
  it('parses ISO dates and datetimes', () => {
    expect(parseDateParam('2026-09-25', 'dateFrom').toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(parseDateParam('2026-09-25T10:30:00Z', 'dateTo').getUTCHours()).toBe(10);
  });
  it('rejects text that is not a date', () => {
    expect(rejection(() => parseDateParam('abc', 'dateFrom'))).toMatch(/valid date/);
    expect(rejection(() => parseDateParam('2026-13-45', 'dateTo'))).toMatch(/valid date/);
  });
});

describe('boundedStrings / nullableText / boundedJsonObject', () => {
  it('boundedStrings rejects a non-string or an over-long listed field and ignores absent ones', () => {
    expect(() => boundedStrings({ title: 'ok' }, { title: 5, other: 5 })).not.toThrow();
    expect(() => boundedStrings({ title: 'toolong' }, { title: 5 })).toThrow();
    expect(() => boundedStrings({ title: 42 }, { title: 5 })).toThrow();
    expect(() => boundedStrings(undefined, { title: 5 })).not.toThrow();
  });
  it('nullableText keeps null (clear) distinct from undefined (leave)', () => {
    expect(nullableText(null, 'kpi', 5)).toBeNull();
    expect(nullableText(undefined, 'kpi', 5)).toBeUndefined();
    expect(() => nullableText('toolong', 'kpi', 5)).toThrow();
  });
  it('boundedJsonObject requires a plain object under the size cap', () => {
    expect(boundedJsonObject({ a: 1 }, 'body', 100)).toEqual({ a: 1 });
    expect(() => boundedJsonObject([1], 'body', 100)).toThrow();
    expect(() => boundedJsonObject('x', 'body', 100)).toThrow();
    expect(() => boundedJsonObject({ a: 'x'.repeat(200) }, 'body', 100)).toThrow();
  });
});
