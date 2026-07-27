import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { UuidParamPipe } from './uuid-param.pipe';

const metadata = { type: 'param', data: 'needId' } as const;

describe('UuidParamPipe', () => {
  const pipe = new UuidParamPipe();

  it('passes through a well-formed UUID unchanged', () => {
    const id = '019fa286-5e34-70d3-abb0-085959ae3894';
    expect(pipe.transform(id, metadata)).toBe(id);
  });

  it('accepts uppercase UUIDs (case-insensitive)', () => {
    const id = '019FA286-5E34-70D3-ABB0-085959AE3894';
    expect(pipe.transform(id, metadata)).toBe(id);
  });

  it('rejects a non-UUID string with the standard VALIDATION_ERROR envelope', () => {
    expect(() => pipe.transform('not-a-uuid', metadata)).toThrow(BadRequestException);
    try {
      pipe.transform('not-a-uuid', metadata);
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      });
    }
  });

  it('rejects an empty string, a partial UUID, and a SQL-injection-shaped value', () => {
    expect(() => pipe.transform('', metadata)).toThrow(BadRequestException);
    expect(() => pipe.transform('019fa286-5e34', metadata)).toThrow(BadRequestException);
    expect(() => pipe.transform("'; DROP TABLE users; --", metadata)).toThrow(BadRequestException);
  });
});
