import { getOrgStore } from '../../tenancy/org-context';
import type { SupportedLocale } from '../../modules/translation/translation.types';

/**
 * The language the current request's caller is viewing the app in, from the
 * x-rio-locale header the frontend API client sends on every request (see
 * OrgContextMiddleware). English when absent — scripts, jobs and tests run
 * outside a request and have always produced English.
 *
 * Used to decide which language an AI summary is GENERATED in and which
 * language a stored one is RETURNED in. Not used for anything that affects
 * figures, enums or access.
 */
export function requestLocale(): SupportedLocale {
  return getOrgStore()?.locale ?? 'en';
}

/** Normalises an explicit `?locale=` query value; anything else is undefined. */
export function parseLocale(value: unknown): SupportedLocale | undefined {
  return value === 'ar' || value === 'en' ? value : undefined;
}
