import { BadRequestException } from '@nestjs/common';
import { T } from './typebox';
import { TypeBoxValidationPipe } from './validation.pipe';

const Schema = T.Object({ body: T.String({ minLength: 1 }) }, { additionalProperties: false });

describe('TypeBoxValidationPipe', () => {
  const pipe = new TypeBoxValidationPipe(Schema);
  const meta = { type: 'body' as const, metatype: undefined, data: undefined };

  it('returns the value when it matches the schema', () => {
    expect(pipe.transform({ body: 'hello' }, meta)).toEqual({ body: 'hello' });
  });

  it('throws a VALIDATION_ERROR envelope when invalid', () => {
    try {
      pipe.transform({ body: '' }, meta);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const res = (e as BadRequestException).getResponse() as {
        error: { code: string; details: unknown };
      };
      expect(res.error.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(res.error.details)).toBe(true);
    }
  });

  it('rejects unknown properties', () => {
    expect(() => pipe.transform({ body: 'ok', extra: 1 }, meta)).toThrow(BadRequestException);
  });
});
