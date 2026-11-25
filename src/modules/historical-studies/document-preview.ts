/**
 * Archive Preview for Word files. A browser cannot display a .docx, so
 * Preview downloaded it. The server converts it to simple HTML with mammoth
 * (already used by the needs importer), keeps only plain document tags, and
 * the Archive page shows it in the same pop-up as a spreadsheet. The file
 * never leaves the server. Images are left out; Download gives the original.
 * Old binary .doc files are not readable by mammoth and are refused.
 */

export const DOCUMENT_PREVIEW_EXTENSIONS = ['.docx'] as const;

/** Enough to read the document; Download gives the rest. */
export const DOCUMENT_PREVIEW_MAX_CHARS = 300_000;

export interface DocumentPreview {
  html: string;
  truncated: boolean;
}

const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'br', 'blockquote',
]);
const VOID_TAGS = new Set(['br']);

/**
 * Keeps only plain document tags and drops every attribute except a table
 * cell's numeric colspan/rowspan. Links, images and anything else are removed
 * (their text stays). mammoth already escapes the document's text, so tags
 * are the only markup in its output.
 */
export function sanitizeDocumentHtml(html: string): string {
  return html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (_m, slash: string, rawTag: string, attrs: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (slash) return VOID_TAGS.has(tag) ? '' : `</${tag}>`;
    const kept: string[] = [];
    if (tag === 'td' || tag === 'th') {
      for (const name of ['colspan', 'rowspan']) {
        const m = new RegExp(`${name}\\s*=\\s*"(\\d{1,3})"`, 'i').exec(attrs);
        if (m) kept.push(`${name}="${m[1]}"`);
      }
    }
    return `<${tag}${kept.length ? ' ' + kept.join(' ') : ''}>`;
  });
}

/**
 * Cuts long output at the last point where every tag is closed, so the page
 * never receives half a table.
 */
export function truncateDocumentHtml(html: string, limit = DOCUMENT_PREVIEW_MAX_CHARS): DocumentPreview {
  if (html.length <= limit) return { html, truncated: false };
  let depth = 0;
  let lastClosed = 0;
  const tags = /<(\/?)([a-z0-9]+)[^>]*>/g;
  for (let m = tags.exec(html); m && m.index < limit; m = tags.exec(html)) {
    const end = m.index + m[0].length;
    if (end > limit) break;
    if (VOID_TAGS.has(m[2]!)) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) lastClosed = end;
  }
  return { html: html.slice(0, lastClosed), truncated: true };
}

/** The document as safe HTML, or null when it cannot be read. */
export async function readDocumentPreview(buffer: Buffer): Promise<DocumentPreview | null> {
  try {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.convertToHtml(
      { buffer },
      // Images are left out of the preview; Download has them.
      { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })) },
    );
    return truncateDocumentHtml(sanitizeDocumentHtml(value));
  } catch {
    return null;
  }
}
