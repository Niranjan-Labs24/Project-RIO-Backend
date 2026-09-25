import { describe, expect, it } from 'vitest';
import { pageOf, parsePaging } from './query.util';

describe('parsePaging', () => {
  it('defaults to 10 rows from offset 0', () => {
    expect(parsePaging()).toEqual({ limit: 10, offset: 0 });
  });
  it('clamps the limit to 1..100 and the offset to 0 or more', () => {
    expect(parsePaging('5000', '-3')).toEqual({ limit: 100, offset: 0 });
    expect(parsePaging('0', '20')).toEqual({ limit: 1, offset: 20 });
  });
  it('falls back to the defaults for non-numeric values', () => {
    expect(parsePaging('abc', 'x')).toEqual({ limit: 10, offset: 0 });
  });
});

describe('pageOf', () => {
  const all = Array.from({ length: 25 }, (_, i) => i);
  it('returns the requested slice with the full total', () => {
    expect(pageOf(all, { limit: 10, offset: 20 })).toEqual({
      items: [20, 21, 22, 23, 24],
      total: 25,
      limit: 10,
      offset: 20,
    });
  });
  it('returns an empty page past the end', () => {
    expect(pageOf(all, { limit: 10, offset: 50 }).items).toEqual([]);
  });
});
