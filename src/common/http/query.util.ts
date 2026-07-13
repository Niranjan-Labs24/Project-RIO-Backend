// Parse an optional numeric query-string param (limit/offset). Returns
// undefined for a missing, empty, or non-numeric value so callers fall back to
// their default and a bad value like `?limit=abc` can never reach Prisma as
// `take: NaN` (which throws a 500). Range clamping is the caller's job.
export function parseIntParam(value?: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
