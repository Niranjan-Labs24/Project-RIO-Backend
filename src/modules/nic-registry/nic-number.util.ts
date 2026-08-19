// Shared by the API (NicRegistryService) and the seed importer
// (prisma/import-nic-registry.ts) so both sides derive the exact same stored
// form — a normalization that differs between write and read would silently
// reject valid registrants.

// Arabic-Indic (U+0660-U+0669) and Extended Arabic-Indic (U+06F0-U+06F9)
// digits. Both blocks run 0-9 in order, so the low nibble of the code point
// is the digit itself.
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

// Separators that ride along when a number is typed with spacing or pasted
// out of a licence PDF: whitespace, NBSP, dashes (incl. the Arabic tatweel
// and en/em dashes), slashes, dots, underscores, and the bidi marks
// U+200E/U+200F/U+061C. Deliberately an explicit list rather than "strip
// every non-digit" — the latter would quietly turn "7011038218-INVALID" into
// a valid-looking number instead of rejecting it.
const SEPARATORS = /[\s ‎‏؜ـ‐-―\-_/.]/g;

/** A NIC number as stored and compared: exactly 10 ASCII digits. */
export const NIC_NUMBER_PATTERN = /^\d{10}$/;

/**
 * Folds a user- or spreadsheet-supplied registration number to its canonical
 * form. Does NOT validate — callers check the result against
 * NIC_NUMBER_PATTERN, so they can report "wrong shape" separately from
 * "not in the registry".
 */
export function normalizeNicNumber(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) & 0x0f))
    .replace(SEPARATORS, '');
}
