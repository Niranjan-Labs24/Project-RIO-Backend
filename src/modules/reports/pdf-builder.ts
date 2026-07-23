// A minimal, dependency-free, but genuinely valid multi-page PDF writer.
// Real report rendering (RIO-NFR-007/008: Arabic RTL, export quality) is a
// documented future step — this exists only so the placeholder export
// actually opens in a PDF viewer instead of being plain text wearing a
// ".pdf" extension. Text is Latin-1/WinAnsi (base Helvetica has no Arabic
// glyphs) — non-Latin-1 characters are replaced with "?" rather than
// corrupting the byte stream; that limitation goes away with the real
// renderer, not before.
function escapePdfText(raw: string): string {
  const latin1Safe = Buffer.from(raw, "utf-8").toString("latin1").replace(/[^\x20-\x7e]/g, "?");
  return latin1Safe.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const words = line.split(" ");
  const wrapped: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxChars) {
      if (current) wrapped.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) wrapped.push(current);
  return wrapped;
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_LEFT = 50;
const MAX_CHARS_PER_LINE = 90;
// Conservative for every page, including the title page — the title itself
// eats roughly 3 lines' worth of vertical space on page 1, so this constant
// stays well under what a title-less page could actually fit. A byte-exact
// per-page fit isn't worth the complexity for a placeholder renderer; this
// just has to never silently overflow past the bottom margin, which the
// previous single-page version did for any report longer than ~45 lines.
const LINES_PER_PAGE = 40;

function buildPageContentStream(title: string | null, lines: string[]): string {
  const parts: string[] = ["BT"];
  if (title) {
    parts.push("/F1 16 Tf", `${MARGIN_LEFT} ${PAGE_HEIGHT - 60} Td`, `(${escapePdfText(title)}) Tj`, "/F2 10 Tf");
    let first = true;
    for (const line of lines) {
      parts.push(`0 -${first ? 24 : 16} Td`, `(${escapePdfText(line)}) Tj`);
      first = false;
    }
  } else {
    parts.push("/F2 10 Tf", `${MARGIN_LEFT} ${PAGE_HEIGHT - 50} Td`);
    let first = true;
    for (const line of lines) {
      parts.push(`0 -${first ? 0 : 16} Td`, `(${escapePdfText(line)}) Tj`);
      first = false;
    }
  }
  parts.push("ET");
  return parts.join("\n");
}

export function buildPlaceholderPdf(title: string, bodyLines: string[]): Buffer {
  const wrappedLines = bodyLines.flatMap((line) => wrapLine(line, MAX_CHARS_PER_LINE));

  // Chunk into one page's worth at a time — page 1 carries the title,
  // every subsequent page is body-only.
  const pageChunks: string[][] = [];
  for (let i = 0; i < wrappedLines.length; i += LINES_PER_PAGE) {
    pageChunks.push(wrappedLines.slice(i, i + LINES_PER_PAGE));
  }
  if (pageChunks.length === 0) pageChunks.push([]);

  const pageCount = pageChunks.length;
  // Object numbering: 1=Catalog, 2=Pages, 3..3+pageCount-1=Page objects,
  // then font objects, then one content-stream object per page.
  const pageObjNums = pageChunks.map((_, i) => 3 + i);
  const fontBoldObjNum = 3 + pageCount;
  const fontRegularObjNum = fontBoldObjNum + 1;
  const firstContentObjNum = fontRegularObjNum + 1;

  const objects: string[] = [];
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`); // 1
  objects.push(
    `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  ); // 2

  pageChunks.forEach((_, i) => {
    const contentObjNum = firstContentObjNum + i;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontBoldObjNum} 0 R /F2 ${fontRegularObjNum} 0 R >> >> /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${contentObjNum} 0 R >>`,
    );
  });

  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"); // fontBoldObjNum
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); // fontRegularObjNum

  pageChunks.forEach((chunk, i) => {
    const contentStream = buildPageContentStream(i === 0 ? title : null, chunk);
    objects.push(`<< /Length ${Buffer.byteLength(contentStream, "latin1")} >>\nstream\n${contentStream}\nendstream`);
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}
