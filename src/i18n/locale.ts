/**
 * The application languages, server-side.
 *
 * Deliberately the same two values as the frontend's `routing.locales`
 * (`Project-RIO-Frontend/src/i18n/routing.ts`) and as `CONSENT_LOCALES`
 * (`modules/consent/consent.types.ts`). Those two lists existed first and are
 * correct; what was missing was a *platform-wide* name for the vocabulary, so
 * the consent module ended up as the accidental owner of it.
 *
 * `CONSENT_LOCALES` stays where it is — a consent acceptance records something
 * narrower and more permanent than a UI preference, and collapsing the two
 * would let a future third UI language silently widen what an immutable
 * acceptance row is allowed to claim.
 */
export const APP_LOCALES = ['en', 'ar'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_APP_LOCALE: AppLocale = 'en';

/** Locales that read right-to-left. Drives table direction, worksheet views
 *  and (once the PDF renderer is replaced) text layout. */
const RTL_LOCALES = new Set<AppLocale>(['ar']);

export function isRtl(locale: AppLocale): boolean {
  return RTL_LOCALES.has(locale);
}

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value);
}

/**
 * Narrows an untrusted value to a supported locale.
 *
 * Falls back rather than throwing: an unrecognised `?locale=` on an export URL
 * should produce an English report, not a 400. The caller asked for a file, and
 * refusing to give them one because a query string was misspelled is a worse
 * outcome than quietly serving the default.
 */
export function toAppLocale(value: unknown, fallback: AppLocale = DEFAULT_APP_LOCALE): AppLocale {
  return isAppLocale(value) ? value : fallback;
}

/**
 * First supported locale named by an `Accept-Language` header.
 *
 * Deliberately simple: it reads the tags in the order the client listed them
 * and takes the first whose primary subtag we support, ignoring q-weights.
 * Full RFC 4647 negotiation buys nothing across a two-language set, and the
 * explicit `?locale=` parameter is the real signal — this is only the fallback
 * for clients that did not send one.
 */
export function localeFromAcceptLanguage(
  header: string | undefined,
  fallback: AppLocale = DEFAULT_APP_LOCALE,
): AppLocale {
  if (!header) return fallback;
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase();
    if (!tag) continue;
    const primary = tag.split('-')[0];
    if (isAppLocale(primary)) return primary;
  }
  return fallback;
}
