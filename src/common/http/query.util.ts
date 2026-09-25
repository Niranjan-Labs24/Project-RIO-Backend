// Parse an optional numeric query-string param (limit/offset). Returns
// undefined for a missing, empty, or non-numeric value so callers fall back to
// their default and a bad value like `?limit=abc` can never reach Prisma as
// `take: NaN` (which throws a 500). Range clamping is the caller's job.
export function parseIntParam(value?: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;

// Clamped limit/offset for a paged list. Default page size is 10; anything
// above MAX_PAGE_SIZE is cut back to it, and a bad value falls to the default.
export function parsePaging(
  limit?: string,
  offset?: string,
): { limit: number; offset: number } {
  const l = parseIntParam(limit);
  const o = parseIntParam(offset);
  return {
    limit: Math.min(Math.max(l ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE),
    offset: Math.max(o ?? 0, 0),
  };
}

export function pageOf<T>(all: T[], paging: { limit: number; offset: number }): Page<T> {
  return {
    items: all.slice(paging.offset, paging.offset + paging.limit),
    total: all.length,
    ...paging,
  };
}
