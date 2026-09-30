import { describe, expect, it } from 'vitest';
import { parseNumericAnswer } from './numeric-answer.util';

describe('parseNumericAnswer', () => {
  it.each([
    ['3', 3],
    ['5 days', 5],
    ['3d', 3],
    ['about 4', 4],
    ['2.5 hours', 2.5],
    ['3-5 days', 3],
    ['2,500', 2500],
    ['12,345,678', 12345678],
    ['-2', -2],
    ['٥ أيام', 5],
    ['۷', 7],
    ['2,5', 2],
    ["don't know", null],
    ['', null],
    [null, null],
    [42, null],
  ])('reads %j as %j', (raw, expected) => {
    expect(parseNumericAnswer(raw)).toBe(expected);
  });
});
