import { describe, expect, it } from 'vitest';
import { sanitizeDocumentHtml, truncateDocumentHtml } from './document-preview';

describe('Word preview HTML (Archive Preview)', () => {
  it('keeps plain document tags and drops links, images, scripts and attributes', () => {
    const html =
      '<h1 class="x">Title</h1><p onclick="x()">Text <a href="javascript:alert(1)">link</a></p>' +
      '<img src="data:x"/><script>bad()</script><table><tr><td colspan="2" style="x">A</td></tr></table>';
    expect(sanitizeDocumentHtml(html)).toBe(
      '<h1>Title</h1><p>Text link</p>bad()<table><tr><td colspan="2">A</td></tr></table>',
    );
  });

  it('cuts a long document only where every tag is closed', () => {
    const html = '<p>one</p><table><tr><td>two</td></tr></table><p>three</p>';
    expect(truncateDocumentHtml(html, 30)).toEqual({ html: '<p>one</p>', truncated: true });
    expect(truncateDocumentHtml(html, 1000)).toEqual({ html, truncated: false });
  });
});
