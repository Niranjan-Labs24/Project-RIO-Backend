// Neutralizes CSV/Excel formula injection ("CSV injection") in
// user-controlled text before it is written into an exported cell (CSV or
// XLSX). A citizen's free-text survey answer, name, or contact value that
// begins with =, +, -, or @ is interpreted as a formula by Excel/Google
// Sheets the moment the exported file is opened — regardless of how the
// file itself marks the cell's type — which can execute arbitrary formulas
// (including data-exfiltration or DDE payloads) on the reviewing officer's
// machine. Leading whitespace or control characters (tab, CR, LF) must not
// be usable to smuggle a formula marker past a naive check, so they are
// stripped before the marker is detected — but the original value (not the
// stripped one) is what actually gets prefixed, so nothing about the
// visible text is otherwise altered.
//
// Prefixing with a single quote is the standard, universally-supported
// mitigation (used by both Excel and Google Sheets) that forces literal-text
// interpretation: the leading quote itself is never displayed once opened,
// so a phone number like +1234567890 still reads as +1234567890 to anyone
// viewing the file — only its underlying cell encoding changes.
//
// Only ever call this on genuinely user-controlled free text (names,
// contact values, survey answers). Never call it on values the application
// itself generated (dates, IDs, computed numbers) — those can't carry an
// injected formula and don't need the leading-quote artifact.
const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@']);

export function sanitizeForSpreadsheet(value: string): string {
  const leadingStripped = value.replace(/^[\s\x00-\x1f]+/, '');
  const marker = leadingStripped.charAt(0);
  if (marker !== '' && FORMULA_TRIGGER_CHARS.has(marker)) {
    return `'${value}`;
  }
  return value;
}
