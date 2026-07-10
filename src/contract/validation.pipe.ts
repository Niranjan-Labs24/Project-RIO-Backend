import { ArgumentMetadata, BadRequestException, PipeTransform } from '@nestjs/common';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { Static, TSchema } from './typebox';

const ajv = new Ajv({ allErrors: true, removeAdditional: false });
addFormats(ajv);

export class TypeBoxValidationPipe<S extends TSchema> implements PipeTransform {
  private readonly validate: ValidateFunction;

  constructor(private readonly schema: S) {
    this.validate = ajv.compile(schema);
  }

  transform(value: unknown, _metadata: ArgumentMetadata): Static<S> {
    if (!this.validate(value)) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: this.validate.errors ?? [],
        },
      });
    }
    return value as Static<S>;
  }
}
