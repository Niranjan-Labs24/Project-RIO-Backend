import { BadRequestException } from '@nestjs/common';

// A shared trim-and-throw check for any "mandatory free-text" field —
// TypeBox's minLength:1 alone still lets a whitespace-only string through
// (it counts raw characters), so every mandatory-notes call site (Survey
// approve/reject, NCNP Report Review approve/reject, ...) shares this one
// implementation rather than each re-deriving the same check.
export function requireNonBlank(value: string, errorCode: string, message: string): void {
  if (!value.trim()) {
    throw new BadRequestException({ error: { code: errorCode, message } });
  }
}
