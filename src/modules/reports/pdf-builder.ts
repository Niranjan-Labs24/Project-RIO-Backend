// A minimal, dependency-free, but genuinely valid single-page PDF writer.
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

export function buildPlaceholderPdf(title: string, bodyLines: string[]): Buffer {
  const pageWidth = 612;
  const pageHeight = 792;
  const marginLeft = 50;
  const maxCharsPerLine = 90;

  const wrappedLines = bodyLines.flatMap((line) => wrapLine(line, maxCharsPerLine));

  const contentParts: string[] = ["BT", "/F1 16 Tf", `${marginLeft} ${pageHeight - 60} Td`, `(${escapePdfText(title)}) Tj`];
  let y = 24;
  contentParts.push("/F2 10 Tf");
  for (const line of wrappedLines) {
    contentParts.push(`0 -${y} Td`, `(${escapePdfText(line)}) Tj`);
    y = 16;
  }
  contentParts.push("ET");
  const contentStream = contentParts.join("\n");

  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objects.push(
    `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents 6 0 R >>`,
  );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push(`<< /Length ${Buffer.byteLength(contentStream, "latin1")} >>\nstream\n${contentStream}\nendstream`);

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
