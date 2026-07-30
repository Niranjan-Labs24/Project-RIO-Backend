import { ArgumentMetadata, BadRequestException, PipeTransform } from '@nestjs/common';

// RFC 4122 UUID (any version) — same format Prisma's uuidv7() output and
// every existing `format: 'uuid'` TypeBox body field already validate
// against, applied here to route params instead. A malformed id (wrong
// shape entirely, or an injection attempt) is rejected before it ever
// reaches a Prisma query, rather than falling through to a generic
// NOT_FOUND once the query predictably matches nothing.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UuidParamPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: `${metadata.data ?? 'id'} must be a valid UUID`,
        },
      });
    }
    return value;
  }
}
