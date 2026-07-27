// Redacts a contact identifier for use in logs — enough left to correlate
// "which delivery failed" across log lines without the identifier itself
// being a PII disclosure. Never used for anything security-sensitive
// (matching, lookups); logging only.

export function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

export function redactPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '***';
  return `***${digits.slice(-4)}`;
}
