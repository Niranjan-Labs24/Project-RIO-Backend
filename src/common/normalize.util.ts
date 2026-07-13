/** Emails are case-insensitive by convention — canonical form is trimmed + lowercased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Registration numbers are identifier codes, conventionally uppercase
 * (matches the seeded demo data, e.g. "REG-DEMO-0001") — canonical form is
 * trimmed + uppercased so "reg-demo-0001" and "REG-DEMO-0001" collide as
 * the same organisation instead of silently coexisting as two rows.
 */
export function normalizeRegistrationNumber(value: string): string {
  return value.trim().toUpperCase();
}
