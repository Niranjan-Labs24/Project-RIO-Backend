import { DEFAULT_APP_LOCALE, type AppLocale } from './locale';
import { MESSAGES, type MessageKey } from './messages';

export type MessageParams = Record<string, string | number>;

/**
 * Resolves one catalogue key in one locale.
 *
 * Deliberately NOT an ICU implementation. The catalogue's parameters are all
 * plain substitutions today, and pulling in a full ICU runtime to interpolate
 * `{n}` would be cost without benefit. The moment a message needs real plural
 * or gender selection — Arabic has singular/dual/plural categories, and
 * `confidence.smallSample`'s "response(s)" is an English fudge that will not
 * translate honestly — swap this function's body for `intl-messageformat` and
 * every call site keeps working, because the key/params interface is the same.
 * That is the reason the signature takes named params rather than a formatted
 * string.
 */
export function translate(
  locale: AppLocale,
  key: MessageKey,
  params?: MessageParams,
): string {
  // A missing key is a programming error, not a translation gap — the
  // catalogue's own types make an untranslated key impossible to add. Fall back
  // to English rather than throwing mid-export: a report with one English label
  // is recoverable; a 500 on download is not.
  const template = MESSAGES[locale]?.[key] ?? MESSAGES[DEFAULT_APP_LOCALE][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/** Curried form, for the many call sites that resolve a dozen keys in one
 *  locale — `const t = translator(locale)` then `t('label.village')`. */
export function translator(locale: AppLocale) {
  return (key: MessageKey, params?: MessageParams): string => translate(locale, key, params);
}

export type Translator = ReturnType<typeof translator>;
