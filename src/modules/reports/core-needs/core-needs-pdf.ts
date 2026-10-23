// Core Needs Report (RPT18) — PDF, drawn to the client's mockup.
//
// Page 1 is the summary (header, area profile, usage status, decision summary,
// confidence, reader guide, approval line) and is also the whole of the
// Executive Summary output. Pages 2–4 follow the mockup's parts: where and what
// to intervene, needs for programme design, evidence and data quality. Long
// tables flow onto further pages with the running header repeated.
//
// Everything is drawn from the CoreView, so the wording is the same as the
// in-app report and the Excel file. Arabic is the same layout mirrored: every
// x below is a left-to-right position and the Pdf primitives mirror it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTENT_W, LEFT, PAGE_H, PAGE_W, Pdf, textWidth, wrap } from '../pdf-builder';
import type { ConfidenceResult } from './core-needs.config';
import type { Cell, CoreView, Tone } from './core-needs-view';

const hex = (h: string): string =>
  [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');

const COLOR = {
  teal: hex('#155463'),
  tealText: hex('#10525d'),
  tealSoft: hex('#9fd3cf'),
  chipBorder: hex('#5e8f99'),
  ink: hex('#1c2125'),
  muted: hex('#6b7280'),
  border: hex('#dfe7e5'),
  panel: hex('#f3f6f6'),
  tint: hex('#e4efed'),
  white: '1 1 1',
  track: hex('#e3e8e6'),
  gold: hex('#c9a227'),
  goldBg: hex('#fdf8e6'),
  blue: hex('#3b7ca7'),
};
// LOW = the v5.0 flag; MEETS = meets the methodology standard; INFO = a
// component shown for information while no threshold is approved.
const BAND: Record<ConfidenceResult | 'INFO', { fg: string; bg: string; edge: string }> = {
  LOW: { fg: hex('#be3a2a'), bg: hex('#fbecea'), edge: hex('#e9b4ab') },
  MEETS: { fg: hex('#3f8a78'), bg: hex('#e8f4f0'), edge: hex('#b5dccf') },
  INFO: { fg: hex('#3b7ca7'), bg: hex('#eaf2f8'), edge: hex('#bfd5e6') },
};
const TONE: Record<Tone, string> = {
  critical: hex('#be3a2a'),
  high: hex('#d9822b'),
  medium: hex('#d8b931'),
  low: hex('#59a694'),
  none: hex('#c9d1d6'),
};
// Drawn over the content at 30% opacity (pdf-builder GSwm): strong enough to
// stand out on every page, light enough to read the text beneath it.
const WATERMARK = hex('#c0392b');

const R = LEFT + CONTENT_W; // right edge of the text area
const FOOTER_TOP = PAGE_H - 34;
const BODY_BOTTOM = PAGE_H - 52;

class Doc {
  pdf = new Pdf();
  /** Section start pages from a first render pass, for the reader guide. */
  constructor(
    readonly v: CoreView,
    readonly pages: Partial<Record<PartAnchor, number>> = {},
  ) {
    this.pdf.dir = v.dir;
  }
  get y(): number {
    return this.pdf.y;
  }
  set y(n: number) {
    this.pdf.y = n;
  }

  // ── text ──
  line(x: number, size: number, bold: boolean, s: string, color = COLOR.ink): void {
    this.pdf.text(x, size, bold, s, color);
  }
  right(xRight: number, size: number, bold: boolean, s: string, color = COLOR.ink): void {
    this.pdf.text(xRight - textWidth(s, size, bold), size, bold, s, color);
  }
  /** Wrapped paragraph from the current y; returns the height used. */
  para(
    x: number,
    w: number,
    s: string,
    size: number,
    bold = false,
    color = COLOR.ink,
    lead = 1.38,
  ): number {
    const lines = wrap(s, size, w, bold);
    const start = this.y;
    for (const ln of lines) {
      this.line(x, size, bold, ln, color);
      this.y += size * lead;
    }
    return this.y - start;
  }
  measure(s: string, size: number, w: number, bold = false, lead = 1.38): number {
    return wrap(s, size, w, bold).length * size * lead;
  }

  // ── boxes ──
  box(
    x: number,
    top: number,
    w: number,
    h: number,
    fill: string | null,
    stroke: string | null,
    r = 6,
    lw = 0.8,
  ): void {
    const keep = this.y;
    this.y = top;
    this.pdf.roundRect(x, w, h, r, fill, stroke, lw);
    this.y = keep;
  }
  bar(x: number, top: number, w: number, h: number, color: string): void {
    const keep = this.y;
    this.y = top;
    this.pdf.rect(x, w, h, color);
    this.y = keep;
  }
  badge(x: number, top: number, text: string, tone: Tone, size = 7.5): number {
    const w = textWidth(text, size, true) + 12;
    this.box(x, top, w, size + 6, TONE[tone], null, (size + 6) / 2);
    const keep = this.y;
    this.y = top + 3;
    this.line(
      x + 6,
      size,
      true,
      text,
      tone === 'medium' || tone === 'none' ? COLOR.ink : COLOR.white,
    );
    this.y = keep;
    return w;
  }

  // ── pages ──
  pageStart(running: boolean): void {
    if (running) this.running();
  }
  newPage(running = true): void {
    this.pdf.newPage();
    this.pageStart(running);
  }
  ensure(h: number): boolean {
    if (this.y + h <= BODY_BOTTOM) return false;
    this.newPage();
    return true;
  }
  watermark(): void {
    const v = this.v;
    const keep = this.y;
    this.pdf.withWatermarkOpacity(() =>
      this.pdf.withRotation(PAGE_W / 2, PAGE_H / 2, 32, () => {
        // As large as fits across the page at this angle, with a margin on
        // each side, so the whole label stays on the page (40 pt at most).
        const fitsAcross = (PAGE_W - 2 * LEFT) / Math.cos((32 * Math.PI) / 180);
        const size = Math.min(40, (40 * fitsAcross) / textWidth(v.watermark!, 40, true));
        const w = textWidth(v.watermark!, size, true);
        this.y = PAGE_H / 2 - size / 2;
        // Drawn in layout coordinates; the page centre is its own mirror image.
        this.pdf.text(PAGE_W / 2 - w / 2, size, true, v.watermark!, WATERMARK);
      }),
    );
    this.y = keep;
  }
  running(): void {
    const v = this.v;
    this.y = 30;
    const usage = v.running.usage;
    // No status pill when the result meets the standard (no warning label).
    const uw = usage ? textWidth(usage, 7.5, true) + 14 : 0;
    if (usage) {
      this.box(R - uw, 26, uw, 15, BAND[v.overall].bg, null, 3);
      this.y = 30;
      this.line(R - uw + 7, 7.5, true, usage, BAND[v.overall].fg);
    }
    this.y = 30;
    const left = fit(v.running.left, 9, CONTENT_W - uw - 16, true);
    this.line(LEFT, 9, true, left, COLOR.tealText);
    this.bar(LEFT, 46, CONTENT_W, 1.2, COLOR.teal);
    this.y = 58;
  }
  partTitle(title: string, lead: string): void {
    this.line(LEFT, 18, true, title, COLOR.tealText);
    this.y += 24;
    this.para(LEFT, CONTENT_W, lead, 8.5, false, COLOR.muted);
    this.y += 8;
  }
  cardTitle(x: number, title: string, size = 10.5): void {
    this.line(x, size, true, title, COLOR.tealText);
  }

  footers(): void {
    const v = this.v;
    const count = this.pdf.pageCount;
    for (let i = 0; i < count; i++) {
      this.pdf.gotoPage(i);
      // Last on the page, so no table or panel drawn later covers it.
      if (v.watermark) this.watermark();
      this.bar(LEFT, FOOTER_TOP - 8, CONTENT_W, 0.6, COLOR.border);
      this.y = FOOTER_TOP;
      if (i === 0)
        this.line(LEFT, 7.5, true, fit(v.approval, 7.5, CONTENT_W - 90, true), COLOR.tealText);
      else {
        const left =
          i === count - 1 && v.output === 'FULL'
            ? `${v.footer.left} · ${v.footer.methodology}`
            : v.footer.left;
        this.line(LEFT, 7.5, false, fit(left, 7.5, CONTENT_W - 90), COLOR.muted);
      }
      this.y = FOOTER_TOP;
      this.right(
        R,
        7.5,
        false,
        v.footer.pageOf.replace('{page}', String(i + 1)).replace('{count}', String(count)),
        COLOR.muted,
      );
    }
  }
}

/** Truncate one line to a width, with an ellipsis. */
function fit(s: string, size: number, w: number, bold = false): string {
  if (textWidth(s, size, bold) <= w) return s;
  let out = s;
  while (out.length > 1 && textWidth(`${out}…`, size, bold) > w) out = out.slice(0, -1);
  return `${out}…`;
}

// ───────────────────────── Page 1 — summary ─────────────────────────

function pageSummary(d: Doc): void {
  const v = d.v;
  d.pageStart(false);

  // Header band, full bleed.
  const badgeW = Math.min(190, Math.max(120, textWidth(v.header.organization, 10, true) + 28));
  const titleW = CONTENT_W - badgeW - 20;
  const titleLines = wrap(v.header.title, 22, titleW, true);
  const chips = layoutChips(v.header.chips, CONTENT_W);
  const bandH = 26 + 14 + titleLines.length * 26 + 16 + chips.rows * 21 + 12;
  d.bar(0, 0, PAGE_W, bandH, COLOR.teal);
  d.y = 24;
  d.line(LEFT, 7.5, true, v.header.kicker, COLOR.tealSoft);
  d.y = 38;
  for (const ln of titleLines) {
    d.line(LEFT, 22, true, ln, COLOR.white);
    d.y += 26;
  }
  d.line(LEFT, 9.5, false, fit(v.header.study, 9.5, titleW), COLOR.white);
  d.y += 16;
  for (const chip of chips.items) {
    d.box(LEFT + chip.x, d.y + chip.row * 21, chip.w, 16, null, COLOR.chipBorder, 8, 0.7);
    const keep = d.y;
    d.y = d.y + chip.row * 21 + 4.5;
    d.line(LEFT + chip.x + 8, 7.5, false, chip.text, COLOR.white);
    d.y = keep;
  }
  // Organisation badge and the platform-owner line.
  d.box(R - badgeW, 20, badgeW, 26, COLOR.white, null, 5);
  d.y = 28.5;
  d.line(
    R - badgeW + 12,
    10,
    true,
    fit(v.header.organization, 10, badgeW - 24, true),
    COLOR.tealText,
  );
  d.y = 54;
  d.right(R, 7.5, false, v.header.platformOwner, COLOR.white);

  d.y = bandH + 14;

  // Area profile.
  const top = d.y;
  const profileH = 104;
  d.box(LEFT, top, CONTENT_W, profileH, COLOR.white, COLOR.border, 6);
  d.y = top + 12;
  d.cardTitle(LEFT + 12, v.profile.title, 10.5);
  d.y = top + 13;
  // Shrunk to fit before it is ever cut: a source or a "58.6 / 41.4%" cut to
  // "41...." loses the very figure the line is there to give.
  const srcSize = shrinkTo(v.profile.source, 7, 5.6, CONTENT_W - 180, false);
  d.right(R - 12, srcSize, false, fit(v.profile.source, srcSize, CONTENT_W - 180), COLOR.muted);
  const tileW = (CONTENT_W - 24 - 5 * 6) / 6;
  v.profile.tiles.forEach((tile, i) => {
    const x = LEFT + 12 + i * (tileW + 6);
    d.box(x, top + 32, tileW, 40, COLOR.panel, null, 4);
    d.y = top + 38;
    d.line(x + 7, 6.5, true, tile.label.toUpperCase(), COLOR.muted);
    d.y = top + 52;
    const vSize = shrinkTo(tile.value, 12, 8, tileW - 12, true);
    d.line(x + 7, vSize, true, fit(tile.value, vSize, tileW - 12, true), COLOR.tealText);
  });
  d.y = top + 82;
  d.line(LEFT + 12, 7.5, false, fit(v.profile.inStudy, 7.5, CONTENT_W - 24), COLOR.ink);
  d.y = top + profileH + 10;

  // Usage status — only when the overall result is Low.
  if (v.usage.show) {
    const band = BAND[v.overall];
    const pill = `${v.usage.label}: ${bandWord(v)}`;
    const pillW = textWidth(pill, 8, true) + 16;
    const usageTextW = CONTENT_W - pillW - 36;
    const usageH = Math.max(34, d.measure(v.usage.text, 8, usageTextW) + 16);
    const uTop = d.y;
    d.box(LEFT, uTop, CONTENT_W, usageH, band.bg, band.edge, 6);
    d.box(LEFT + 12, uTop + usageH / 2 - 8, pillW, 16, band.fg, null, 3);
    d.y = uTop + usageH / 2 - 4.5;
    d.line(LEFT + 20, 8, true, pill, COLOR.white);
    d.y = uTop + 8;
    d.para(LEFT + 24 + pillW, usageTextW, v.usage.text, 8, false, band.fg);
    d.y = uTop + usageH + 10;
  }

  // Decision summary.
  const textW = CONTENT_W - 28;
  const blocks = [v.decision.find, v.decision.confident, v.decision.decide];
  const blocksH = blocks.reduce((h, b) => h + 13 + d.measure(b.text, 8.6, textW) + 7, 0);
  const dTop = d.y;
  const dH = 30 + blocksH + 4;
  d.box(LEFT, dTop, CONTENT_W, dH, COLOR.panel, null, 6);
  d.y = dTop + 12;
  d.cardTitle(LEFT + 14, v.decision.title, 11);
  d.y = dTop + 14;
  d.right(R - 14, 7, false, v.decision.issuedAlone, COLOR.muted);
  d.y = dTop + 32;
  for (const b of blocks) {
    d.line(LEFT + 14, 8, true, b.q.toUpperCase(), hex('#66b0ad'));
    d.y += 13;
    d.para(LEFT + 14, textW, b.text, 8.6, false, COLOR.ink);
    d.y += 7;
  }
  d.y = dTop + dH + 10;

  // Confidence.
  const cTop = d.y;
  const cH = 30 + v.confidence.rows.length * 27 + 6;
  d.box(LEFT, cTop, CONTENT_W, cH, COLOR.white, COLOR.border, 6);
  d.y = cTop + 12;
  d.line(LEFT + 14, 10.5, true, v.confidence.title, BAND[v.overall].fg);
  d.y = cTop + 14;
  d.right(R - 14, 7, false, v.confidence.rule, COLOR.muted);
  v.confidence.rows.forEach((row, i) => {
    const rt = cTop + 34 + i * 27;
    d.y = rt;
    d.line(LEFT + 14, 8.5, true, row.label, COLOR.ink);
    d.y = rt + 11;
    d.line(LEFT + 14, 7, false, row.sub, COLOR.muted);
    const bx = LEFT + 150;
    const bw = 230;
    d.box(bx, rt + 4, bw, 7, COLOR.track, null, 3.5);
    if (row.ratio > 0)
      d.box(
        bx,
        rt + 4,
        Math.max(7, bw * Math.min(1, row.ratio)),
        7,
        BAND[row.band ?? 'INFO'].fg,
        null,
        3.5,
      );
    d.y = rt;
    d.right(R - 14, 8, true, row.value, COLOR.ink);
    d.y = rt + 11;
    d.right(R - 14, 7.5, true, row.bandLabel, BAND[row.band ?? 'INFO'].fg);
  });
  d.y = cTop + cH + 10;

  // Reader guide.
  if (v.output === 'FULL') {
    const gTop = d.y;
    const gw = (CONTENT_W - 3 * 8) / 4;
    const colors = [COLOR.teal, COLOR.blue, hex('#59a694'), COLOR.gold];
    // Real page numbers from the first render pass, and each box a link to
    // its section ("each section linked from the contents page").
    const P = d.pages;
    const range = (from?: number, to?: number) =>
      from == null ? null : to != null && to > from ? `${from}–${to}` : String(from);
    const pagesOf: Record<(typeof v.guide)[number]['part'], string | null> = {
      summary: '1',
      programmes: range(
        P['part-where'],
        P['part-evidence'] != null ? P['part-evidence'] - 1 : undefined,
      ),
      research: range(P['part-evidence']),
      donors: range(P['part-cards'] ?? P['part-evidence']),
    };
    const target: Record<(typeof v.guide)[number]['part'], PartAnchor | null> = {
      summary: null,
      programmes: 'part-where',
      research: 'part-evidence',
      donors: P['part-cards'] != null ? 'part-cards' : 'part-evidence',
    };
    v.guide.forEach((g, i) => {
      const x = LEFT + i * (gw + 8);
      d.box(x, gTop, gw, 44, COLOR.panel, null, 4);
      d.bar(x, gTop, gw, 2.2, colors[i]!);
      const pages = pagesOf[g.part];
      const to = target[g.part];
      if (to && pages) {
        d.y = gTop;
        d.pdf.link(x, gw, 44, to);
      }
      d.y = gTop + 9;
      const label = pages ? g.pageLabel.replace('{pages}', pages) : g.title;
      d.line(x + 8, 8, true, fit(label, 8, gw - 14, true), COLOR.tealText);
      d.y = gTop + 22;
      d.para(x + 8, gw - 14, g.q, 7.2, false, COLOR.muted, 1.3);
    });
  }
}

/** The largest size from `max` down to `min` at which `s` fits `width`. */
function shrinkTo(s: string, max: number, min: number, width: number, bold: boolean): number {
  let size = max;
  while (size > min && textWidth(s, size, bold) > width) size -= 0.5;
  return size;
}

/** Chips laid out left to right, wrapping to a new row when full. */
function layoutChips(
  texts: string[],
  width: number,
): { rows: number; items: Array<{ x: number; row: number; w: number; text: string }> } {
  const items: Array<{ x: number; row: number; w: number; text: string }> = [];
  let x = 0;
  let row = 0;
  for (const raw of texts) {
    const text = fit(raw, 7.5, width - 20);
    const w = textWidth(text, 7.5, false) + 16;
    if (x > 0 && x + w > width) {
      row++;
      x = 0;
    }
    items.push({ x, row, w, text });
    x += w + 6;
  }
  return { rows: row + 1, items };
}

function bandWord(v: CoreView): string {
  return v.running.usage;
}

// ───────────────────────── tables ─────────────────────────

interface TableOpts {
  x?: number;
  w?: number;
  widths: number[]; // fractions
  header: 'teal' | 'tint';
  size?: number;
  rowGap?: number;
}

/** A designed table that flows across pages, repeating its column header. */
function table(d: Doc, columns: string[], rows: Cell[][], o: TableOpts): void {
  const x0 = o.x ?? LEFT;
  const w = o.w ?? CONTENT_W;
  const size = o.size ?? 8;
  const pad = 8;
  const colW = o.widths.map((f) => f * w);
  const colX = colW.map((_, i) => x0 + colW.slice(0, i).reduce((a, b) => a + b, 0));

  const drawHeader = () => {
    const h = 20;
    d.box(x0, d.y, w, h, o.header === 'teal' ? COLOR.teal : COLOR.tint, null, 4);
    const keep = d.y;
    d.y += 6;
    columns.forEach((c, i) => {
      const s = fit(c, 7.5, colW[i]! - pad * 2, true);
      const color = o.header === 'teal' ? COLOR.white : COLOR.tealText;
      if (i === columns.length - 1 && columns.length > 2)
        d.right(colX[i]! + colW[i]! - pad, 7.5, true, s, color);
      else d.line(colX[i]! + pad, 7.5, true, s, color);
    });
    d.y = keep + h + 2;
  };

  const rowHeight = (row: Cell[]): number =>
    Math.max(
      ...row.map((cell, i) => {
        if (cell.badge) return 18;
        const lines = wrap(cell.text, size, colW[i]! - pad * 2, !!cell.bold).length;
        const sub = cell.sub ? wrap(cell.sub, size - 1.2, colW[i]! - pad * 2).length : 0;
        return lines * size * 1.32 + sub * (size - 1.2) * 1.3 + (cell.progress != null ? 7 : 0) + 8;
      }),
    ) + (o.rowGap ?? 0);

  d.ensure(40);
  drawHeader();
  rows.forEach((row) => {
    const h = rowHeight(row);
    if (d.ensure(h + 2)) drawHeader();
    const top = d.y;
    row.forEach((cell, i) => {
      const cx = colX[i]! + pad;
      const cw = colW[i]! - pad * 2;
      d.y = top + 5;
      const last = i === row.length - 1 && row.length > 2;
      if (cell.badge) {
        const bw = textWidth(cell.text, 7.5, true) + 12;
        d.badge(
          last ? colX[i]! + colW[i]! - pad - bw : cx,
          top + 3,
          cell.text,
          cell.tone ?? 'none',
        );
        return;
      }
      const color =
        cell.tone && cell.tone !== 'none' && !cell.badge
          ? TONE[cell.tone]
          : cell.muted
            ? COLOR.muted
            : COLOR.ink;
      for (const ln of wrap(cell.text, size, cw, !!cell.bold)) {
        if (last) d.right(colX[i]! + colW[i]! - pad, size, !!cell.bold, ln, color);
        else d.line(cx, size, !!cell.bold, ln, color);
        d.y += size * 1.32;
      }
      if (cell.sub)
        for (const ln of wrap(cell.sub, size - 1.2, cw)) {
          if (last) d.right(colX[i]! + colW[i]! - pad, size - 1.2, false, ln, COLOR.muted);
          else d.line(cx, size - 1.2, false, ln, COLOR.muted);
          d.y += (size - 1.2) * 1.3;
        }
      if (cell.progress != null) {
        const pw = Math.min(cw, 80);
        d.box(cx, d.y + 1, pw, 4, COLOR.track, null, 2);
        if (cell.progress > 0)
          d.box(
            cx,
            d.y + 1,
            Math.max(4, pw * cell.progress),
            4,
            cell.progress >= 1 ? TONE.low : COLOR.teal,
            null,
            2,
          );
      }
    });
    d.y = top + h;
    d.bar(x0 + 4, d.y - 0.5, w - 8, 0.5, COLOR.border);
  });
  d.y += 6;
}

// ───────────────────────── Page 2 — where and what ─────────────────────────

function pageWhere(d: Doc): void {
  const v = d.v;
  d.newPage();
  d.pdf.anchor('part-where');
  d.partTitle(v.where.title, v.where.lead);

  if (v.where.map && v.where.units) {
    const top = d.y;
    const mapW = 236;
    // Just tall enough for the map and its two legend rows.
    const mapH = 214;
    d.box(LEFT, top, mapW, mapH, COLOR.white, COLOR.border, 6);
    d.y = top + 10;
    d.cardTitle(LEFT + 10, fit(v.where.map.title, 9.5, mapW - 20, true), 9.5);
    drawMap(d, v.where.map, LEFT + 10, top + 28, mapW - 20, 150);
    // Swatch legend.
    let ly = top + 186;
    let lx = LEFT + 10;
    // As the dashboard map: areas outside the study and areas with no data
    // look the same, so one swatch covers both.
    for (const item of v.where.map.legendItems.filter((i) => i.kind !== 'outside')) {
      const lw = textWidth(item.label, 6.6, false) + 16;
      if (lx + lw > LEFT + mapW - 10) {
        lx = LEFT + 10;
        ly += 12;
      }
      const sw =
        item.kind === 'hatched'
          ? hex('#8A9299')
          : item.kind === 'nodata' || item.kind === 'outside'
            ? hex('#E2E6EA')
            : MAP_FILL(
                item.kind === 'critical'
                  ? 80
                  : item.kind === 'high'
                    ? 60
                    : item.kind === 'medium'
                      ? 40
                      : 10,
              );
      d.box(lx, ly + 1, 8, 8, sw, hex('#98A2AE'), 1, 0.4);
      d.y = ly + 1;
      d.line(lx + 11, 6.6, false, item.label, COLOR.muted);
      lx += lw + 6;
    }

    // Governorates table to the side.
    const tx = LEFT + mapW + 12;
    const tw = CONTENT_W - mapW - 12;
    d.y = top;
    d.cardTitle(tx, v.where.units.title, 10);
    d.y = top + 18;
    table(d, v.where.units.columns, v.where.units.rows, {
      x: tx,
      w: tw,
      widths: v.where.units.columns.length === 4 ? [0.3, 0.2, 0.26, 0.24] : [0.4, 0.34, 0.26],
      header: 'teal',
      size: 7.8,
    });
    d.para(tx, tw, v.where.units.note, 7, false, COLOR.muted, 1.3);
    d.y += 6;
    const rankH = d.measure(v.where.units.ranking, 7.5, tw - 20) + 14;
    d.box(tx, d.y, tw, rankH, COLOR.panel, null, 5);
    d.y += 7;
    d.para(tx + 10, tw - 20, v.where.units.ranking, 7.5, false, COLOR.ink, 1.3);
    d.y = Math.max(d.y + 10, top + mapH + 14);
  } else if (v.where.units) {
    d.cardTitle(LEFT, v.where.units.title, 10);
    d.y += 18;
    table(d, v.where.units.columns, v.where.units.rows, {
      widths: v.where.units.columns.length === 4 ? [0.34, 0.22, 0.24, 0.2] : [0.44, 0.32, 0.24],
      header: 'teal',
    });
    d.para(LEFT, CONTENT_W, v.where.units.note, 7, false, COLOR.muted);
    d.para(LEFT, CONTENT_W, v.where.units.ranking, 7.5, false, COLOR.ink);
    d.y += 8;
  }

  if (v.where.villages) {
    d.ensure(70);
    d.cardTitle(LEFT, v.where.villages.title, 10.5);
    d.y += 18;
    if (v.where.villages.rows.length)
      table(d, v.where.villages.columns, v.where.villages.rows, {
        widths: [0.3, 0.2, 0.17, 0.17, 0.16],
        header: 'tint',
      });
    d.para(LEFT, CONTENT_W, v.where.villages.note, 7, false, COLOR.muted);
    d.y += 8;
  }

  const n = v.where.needs;
  d.ensure(80);
  const titleY = d.y;
  d.cardTitle(LEFT, n.provisional ? `${n.title} — ${n.provisional}` : n.title, 10.5);
  d.y = titleY + 1;
  d.right(R, 7.5, false, n.rankedBy, COLOR.muted);
  d.y = titleY + 18;
  if (n.rows.length) {
    // The actual value is the longest cell; giving it room keeps each row
    // to two lines, so the ten needs fit beside the map section.
    const widths =
      n.columns.length === 6 ? [0.05, 0.36, 0.16, 0.21, 0.11, 0.11] : [0.05, 0.47, 0.24, 0.12, 0.12];
    table(d, n.columns, n.rows, { widths, header: 'teal', size: 7.8 });
  } else d.para(LEFT, CONTENT_W, n.empty, 8.5, false, COLOR.muted);
}

/** The needs map: real boundaries from the platform's own map files, zoomed
 *  to the study's own units with a margin of their neighbours for context, in
 *  a fixed frame so it is the same size whatever the area's shape. */
function drawMap(
  d: Doc,
  map: NonNullable<CoreView['where']['map']>,
  x: number,
  top: number,
  w: number,
  h: number,
): void {
  const features = loadBoundaries(map.level);
  if (!features) return;
  const byCode = new Map(features.map((f) => [f.key, f]));
  const units = map.units
    .filter((u) => u.code && byCode.has(u.code))
    .map((u) => ({ u, f: byCode.get(u.code!)! }));
  const context = map.context.filter((c) => byCode.has(c.code)).map((c) => byCode.get(c.code)!);
  const focus = units.length ? units.map((x) => x.f) : context;
  if (!focus.length) return;

  const frame = fitFrame(focus, w / h);
  const project = ([lon, lat]: [number, number]): [number, number] => [
    x + ((lon - frame.minX) * frame.k * w) / frame.spanX,
    top + ((frame.maxY - lat) * h) / frame.spanY,
  ];

  // Geography is never mirrored: in Arabic the map keeps north up and east
  // right; only its slot on the page follows the reading direction.
  const rtl = d.pdf.dir === 'rtl';
  const shift = rtl ? LEFT + CONTENT_W - (x + w) - (x - LEFT) : 0;
  const P = (pt: [number, number]): [number, number] => {
    const [px, py] = project(pt);
    return [px + shift, py];
  };
  d.pdf.dir = 'ltr';
  d.y = top;
  d.pdf.clipRound(x + shift, w, h, 4);
  d.box(x + shift, top, w, h, hex('#DDDDDD'), null, 4);

  // Neighbours first, faint, so the study's own units sit on top.
  for (const f of context)
    for (const ring of f.rings) {
      const pts = ring.map(P);
      d.pdf.fillPolygon(pts, hex('#E2E6EA'));
      d.pdf.strokePath(pts, hex('#98A2AE'), 0.5, true);
    }
  for (const { u, f } of units) {
    const fill =
      u.status === 'SHOWN'
        ? MAP_FILL(u.severity)
        : u.status === 'NOT_SHOWN'
          ? hex('#8A9299')
          : hex('#E2E6EA');
    for (const ring of f.rings) {
      const pts = ring.map(P);
      d.pdf.fillPolygon(pts, fill);
    }
  }
  // Outlines of the study's units drawn last, so each reads as a shape.
  for (const { f } of units)
    for (const ring of f.rings) d.pdf.strokePath(ring.map(P), '1 1 1', 0.8, true);
  for (const { f } of units)
    for (const ring of f.rings) d.pdf.strokePath(ring.map(P), hex('#4b5b60'), 0.35, true);

  // Labels on a white backing so they stay readable over any colour. A unit
  // too small to hold its label gets a marker and the label beside it on a
  // leader line; labels never overlap each other.
  const placed: Array<[number, number, number, number]> = [];
  const overlaps = (r: [number, number, number, number]) =>
    placed.some(
      (p) => r[0] < p[0] + p[2] && p[0] < r[0] + r[2] && r[1] < p[1] + p[3] && p[1] < r[1] + r[3],
    );
  for (const { u, f } of units) {
    const pts = f.rings.flat().map(P);
    const bx = Math.min(...pts.map((p) => p[0])),
      by = Math.min(...pts.map((p) => p[1]));
    const bw0 = Math.max(...pts.map((p) => p[0])) - bx,
      bh0 = Math.max(...pts.map((p) => p[1])) - by;
    const [cx, cy] = P(centroid(f.rings));
    const nw = textWidth(u.name, 6.6, true);
    const cw = textWidth(u.caption, 5.8, false);
    const lw = Math.max(nw, cw) + 6;
    const tiny = bw0 < lw || bh0 < 18;
    let lx = tiny ? cx + 10 : cx - lw / 2;
    let ly = tiny ? cy - 26 : cy - 9;
    if (lx + lw > x + shift + w - 2) lx = cx - 10 - lw;
    if (ly < top + 2) ly = cy + 8;
    for (let i = 0; i < 6 && overlaps([lx, ly, lw, 18]); i++) ly += 20;
    placed.push([lx, ly, lw, 18]);
    if (tiny) {
      d.pdf.strokePath(
        [
          [cx, cy],
          [lx + (lx > cx ? 0 : lw), ly + 9],
        ],
        hex('#6b7280'),
        0.4,
      );
      d.pdf.disc(cx, cy, 2.6, '1 1 1');
      d.pdf.disc(
        cx,
        cy,
        1.9,
        u.status === 'SHOWN'
          ? MAP_FILL(u.severity)
          : u.status === 'NOT_SHOWN'
            ? TONE.critical
            : hex('#c9d1d6'),
      );
    }
    haloText(d, lx + (lw - nw) / 2, ly + 1.5, 6.6, true, u.name, COLOR.ink);
    haloText(d, lx + (lw - cw) / 2, ly + 9.5, 5.8, false, u.caption, hex('#4b5563'));
  }
  d.pdf.unclip();
  d.pdf.dir = rtl ? 'rtl' : 'ltr';
}

/** Map label with a thin white halo, so it reads over any fill without a box. */
function haloText(
  d: Doc,
  x: number,
  top: number,
  size: number,
  bold: boolean,
  str: string,
  color: string,
): void {
  for (const [dx, dy] of [
    [-0.6, 0],
    [0.6, 0],
    [0, -0.6],
    [0, 0.6],
    [-0.45, -0.45],
    [0.45, 0.45],
    [-0.45, 0.45],
    [0.45, -0.45],
  ] as const) {
    d.y = top + dy;
    d.line(x + dx, size, bold, str, '1 1 1');
  }
  d.y = top;
  d.line(x, size, bold, str, color);
}

// The Geographic Dashboard's band colours (needs-map.tsx BAND_COLOURS), so the
// PDF map and the in-app map read the same.
const MAP_FILL = (sev: number | null): string =>
  sev === null
    ? hex('#8A9299')
    : sev >= 70
      ? hex('#B4232A')
      : sev >= 50
        ? hex('#D9760F')
        : sev >= 30
          ? hex('#C9A227')
          : hex('#3F7D58');

/** The map frame: the focus units' bounds plus a 20% margin, widened in one
 *  direction to the box's aspect ratio (latitude-corrected), so every map
 *  fills its box the same way. */
function fitFrame(focus: Boundary[], aspect: number) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const f of focus)
    for (const ring of f.rings)
      for (const [lon, lat] of ring) {
        minX = Math.min(minX, lon);
        maxX = Math.max(maxX, lon);
        minY = Math.min(minY, lat);
        maxY = Math.max(maxY, lat);
      }
  const k = Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
  let spanX = Math.max((maxX - minX) * k, 0.05) * 1.4;
  let spanY = Math.max(maxY - minY, 0.05) * 1.4;
  if (spanX / spanY > aspect) spanY = spanX / aspect;
  else spanX = spanY * aspect;
  const cx = ((minX + maxX) / 2) * k;
  const cy = (minY + maxY) / 2;
  return { k, spanX, spanY, minX: (cx - spanX / 2) / k, maxY: cy + spanY / 2 };
}

interface Boundary {
  key: string;
  rings: Array<Array<[number, number]>>;
}
const BOUNDARY_FILES = {
  REGION: 'sa-regions.geojson',
  GOVERNORATE: 'sa-governorates.geojson',
  CENTRE: 'sa-centers.geojson',
} as const;
const boundaryCache = new Map<string, Boundary[] | null>();
function loadBoundaries(level: 'REGION' | 'GOVERNORATE' | 'CENTRE' | null): Boundary[] | null {
  if (!level) return null;
  if (boundaryCache.has(level)) return boundaryCache.get(level)!;
  let out: Boundary[] | null = null;
  try {
    const raw = JSON.parse(
      readFileSync(join(__dirname, '../../../../assets/geo', BOUNDARY_FILES[level]), 'utf8'),
    ) as {
      features: Array<{
        properties: { key: string; iso?: string };
        geometry: { type: string; coordinates: unknown };
      }>;
    };
    out = raw.features.map((f) => {
      const polys =
        f.geometry.type === 'MultiPolygon'
          ? (f.geometry.coordinates as Array<Array<Array<[number, number]>>>)
          : [f.geometry.coordinates as Array<Array<[number, number]>>];
      return {
        // Keyed like the in-app map: regions by their numeric code (Region.code).
        key: f.properties.key,
        rings: polys.map((p) => p[0]!).filter(Boolean),
      };
    });
  } catch {
    out = null; // a missing map file drops the map, never the report
  }
  boundaryCache.set(level, out);
  return out;
}

function centroid(rings: Array<Array<[number, number]>>): [number, number] {
  // The largest ring's average vertex — good enough to place a label.
  const ring = rings.reduce((a, b) => (b.length > a.length ? b : a), rings[0]!);
  const sx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const sy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  return [sx, sy];
}

// ───────────────────────── Page 3 — programme design ─────────────────────────

function pageDesign(d: Doc): void {
  const v = d.v;
  d.newPage();
  d.pdf.anchor('part-design');
  d.partTitle(v.design.title, v.design.lead);

  // Severity by domain.
  const dm = v.design.domains;
  const titleY = d.y;
  d.cardTitle(LEFT, dm.title, 10.5);
  // Legend to the right.
  let lx = R;
  for (const item of [...dm.legend].reverse()) {
    const w = textWidth(item.label, 7, false);
    lx -= w;
    d.y = titleY + 2;
    d.line(lx, 7, false, item.label, COLOR.muted);
    lx -= 10;
    d.box(lx, titleY + 2.5, 7, 7, TONE[item.tone], null, 1); // square, as the mockup
    lx -= 12;
  }
  d.y = titleY + 20;
  for (const row of dm.rows) {
    d.ensure(row.flag ? 24 : 16);
    const top = d.y;
    d.line(LEFT, 8.5, true, fit(row.name, 8.5, 140, true), COLOR.ink);
    if (row.flag) {
      // v5.0 no-masking: a Critical KPI inside the domain is named under it.
      d.y = top + 10.5;
      d.line(LEFT, 6.8, true, fit(row.flag, 6.8, 140, true), TONE.critical);
    }
    const bx = LEFT + 150;
    const bw = CONTENT_W - 150 - 160;
    d.box(bx, top + 1.5, bw, 9, COLOR.track, null, 4.5);
    // An unmeasured domain is a full grey bar, not an empty track.
    const barW = row.severity != null ? Math.max(9, (bw * row.severity) / 100) : bw;
    d.box(bx, top + 1.5, barW, 9, TONE[row.tone], null, 4.5);
    d.y = top;
    d.right(
      R - 114,
      row.severity != null ? 8.5 : 7.5,
      row.severity != null,
      row.value,
      row.severity != null ? COLOR.ink : COLOR.muted,
    );
    d.y = top;
    d.right(R - 70, 7.5, false, row.weight, COLOR.muted);
    d.y = top;
    d.right(R, 7.5, true, row.fit, TONE[row.fitTone]);
    d.y = top + (row.flag ? 24 : 16);
  }
  if (dm.others) {
    d.para(LEFT, CONTENT_W, dm.others, 7.5, false, COLOR.muted);
  }
  d.y += 10;

  // Needs hierarchy.
  const hi = v.design.hierarchy;
  d.ensure(80);
  d.cardTitle(LEFT, hi.title, 10.5);
  d.y += 18;
  const flat: Cell[][] = [];
  const groupRows = new Set<number>();
  for (const g of hi.groups) {
    groupRows.add(flat.length);
    flat.push([
      { text: g.title, bold: true },
      { text: '' },
      { text: '' },
      { text: '' },
      { text: '' },
      { text: '' },
      { text: g.severity, bold: true },
    ]);
    flat.push(...g.rows);
  }
  hierarchyTable(d, hi.columns, flat, groupRows);
  d.para(LEFT, CONTENT_W, hi.note, 7, false, COLOR.muted, 1.3);
  d.y += 12;

  // How to read the numbers + links between indicators (the latter only once
  // indicator pairs are configured — otherwise the reading box takes the row).
  const showLinks = v.design.links.show;
  const half = showLinks ? (CONTENT_W - 12) / 2 : CONTENT_W;
  const readH =
    30 +
    v.design.reading.lines.reduce(
      (h, l) => h + d.measure(l.lead ? `${l.lead} ${l.text}` : l.text, 7.8, half - 24) + 3,
      0,
    );
  const linksH = showLinks
    ? 30 + v.design.links.lines.reduce((h, l) => h + d.measure(l, 7.8, half - 24) + 4, 0)
    : 0;
  const boxH = Math.max(readH, linksH);
  d.ensure(boxH + 4);
  const top = d.y;
  d.box(LEFT, top, half, boxH, COLOR.panel, null, 6);
  d.y = top + 12;
  d.cardTitle(LEFT + 12, v.design.reading.title, 9.5);
  d.y = top + 30;
  for (const l of v.design.reading.lines) {
    d.para(
      LEFT + 12,
      half - 24,
      l.lead ? `${l.lead}: ${l.text}` : l.text,
      7.8,
      false,
      COLOR.ink,
      1.32,
    );
    d.y += 3;
  }
  if (!showLinks) {
    d.y = top + boxH + 10;
    return;
  }
  const lx2 = LEFT + half + 12;
  d.box(lx2, top, half, boxH, COLOR.white, COLOR.chipBorder, 6, 0.6);
  d.y = top + 12;
  d.cardTitle(lx2 + 12, v.design.links.title, 9.5);
  d.y = top + 13;
  d.right(lx2 + half - 12, 7, false, v.design.links.tag, COLOR.muted);
  d.y = top + 30;
  for (const l of v.design.links.lines) {
    d.para(lx2 + 12, half - 24, l, 7.8, false, COLOR.ink, 1.32);
    d.y += 4;
  }
  d.y = top + boxH + 10;
}

/** The hierarchy table: teal header, tinted domain › sub-domain rows. */
function hierarchyTable(d: Doc, columns: string[], rows: Cell[][], groupRows: Set<number>): void {
  // KPI, actual, severity, priority, fit to publish, gap type, target group, baseline.
  // Priority wide enough for "Critical (provisional)" on two lines.
  const widths = [0.23, 0.16, 0.08, 0.12, 0.12, 0.09, 0.11, 0.09].map((f) => f * CONTENT_W);
  const xs = widths.map((_, i) => LEFT + widths.slice(0, i).reduce((a, b) => a + b, 0));
  const pad = 6;
  const header = () => {
    d.box(LEFT, d.y, CONTENT_W, 20, COLOR.teal, null, 4);
    const keep = d.y;
    d.y += 6;
    columns.forEach((c, i) =>
      d.line(xs[i]! + pad, 7.3, true, fit(c, 7.3, widths[i]! - pad * 2, true), COLOR.white),
    );
    d.y = keep + 22;
  };
  d.ensure(50);
  header();
  rows.forEach((row, idx) => {
    if (groupRows.has(idx)) {
      if (d.ensure(40)) header();
      const top = d.y;
      d.box(LEFT, top, CONTENT_W, 18, COLOR.tint, null, 3);
      d.y = top + 5;
      d.line(xs[0]! + pad, 8, true, fit(row[0]!.text, 8, CONTENT_W - 80, true), COLOR.tealText);
      d.y = top + 5;
      d.right(LEFT + CONTENT_W - pad, 8, true, row[6]!.text, COLOR.tealText);
      d.y = top + 20;
      return;
    }
    const h =
      Math.max(
        ...row.map((cell, i) =>
          cell.badge
            ? 16
            : wrap(cell.text, 7.6, widths[i]! - pad * 2, !!cell.bold).length * 10 +
              (cell.sub ? wrap(cell.sub, 6.6, widths[i]! - pad * 2).length * 8.6 : 0),
        ),
      ) + 8;
    if (d.ensure(h)) header();
    const top = d.y;
    row.forEach((cell, i) => {
      d.y = top + 4;
      if (cell.badge) {
        d.badge(xs[i]! + pad, top + 3, cell.text, cell.tone ?? 'none', 7.2);
        return;
      }
      const color =
        cell.tone && cell.tone !== 'none' ? TONE[cell.tone] : cell.muted ? COLOR.muted : COLOR.ink;
      if (cell.sub && i === 0) {
        for (const ln of wrap(cell.sub, 6.6, widths[i]! - pad * 2)) {
          d.line(xs[i]! + pad, 6.6, false, ln, COLOR.muted);
          d.y += 8.6;
        }
      }
      for (const ln of wrap(cell.text, 7.6, widths[i]! - pad * 2, !!cell.bold)) {
        d.line(xs[i]! + pad, 7.6, !!cell.bold, ln, color);
        d.y += 10;
      }
      if (cell.sub && i !== 0)
        for (const ln of wrap(cell.sub, 6.6, widths[i]! - pad * 2)) {
          d.line(xs[i]! + pad, 6.6, false, ln, COLOR.muted);
          d.y += 8.6;
        }
    });
    d.y = top + h;
    d.bar(LEFT + 4, d.y - 0.5, CONTENT_W - 8, 0.5, COLOR.border);
  });
  d.y += 6;
}

// ───────────────────────── Page 4 — evidence ─────────────────────────

function pageEvidence(d: Doc): void {
  const v = d.v;
  const e = v.evidence;
  d.newPage();
  d.pdf.anchor('part-evidence');
  d.partTitle(e.title, e.lead);

  const half = (CONTENT_W - 12) / 2;
  const top = d.y;
  // Sample distribution (left).
  const distRows = e.distribution.rows.length;
  // A label and value that do not fit on one line (the exclusion reason, the
  // collection method) take two, the value under its label.
  const respTwoLine = (row: { label: string; value: string }) =>
    textWidth(row.label, 7.8, false) + textWidth(row.value, 7.8, true) + 16 > half - 24;
  const respH = e.responses.rows.reduce(
    (h, row) =>
      h + (respTwoLine(row) ? 13 + d.measure(row.value, 7.8, half - 24, true, 1.3) + 3 : 15),
    0,
  );
  const noteH = d.measure(e.responses.note, 6.8, half - 24, false, 1.25);
  const boxH = Math.max(46 + distRows * 15 + 34, 32 + respH + 44 + noteH + 4);
  d.ensure(boxH);
  d.box(LEFT, top, half, boxH, COLOR.white, COLOR.border, 6);
  d.y = top + 12;
  d.cardTitle(LEFT + 12, e.distribution.title, 9.5);
  d.y = top + 32;
  const cw = [0.62, 0.16, 0.22].map((f) => f * (half - 24));
  e.distribution.columns.forEach((c, i) => {
    const x = LEFT + 12 + cw.slice(0, i).reduce((a, b) => a + b, 0);
    if (i === 0) d.line(x, 7.5, true, c, COLOR.ink);
    else d.right(x + cw[i]!, 7.5, true, c, COLOR.ink);
  });
  d.y = top + 46;
  for (const row of e.distribution.rows) {
    const yy = d.y;
    row.forEach((cell, i) => {
      d.y = yy;
      const x = LEFT + 12 + cw.slice(0, i).reduce((a, b) => a + b, 0);
      if (i === 0)
        d.line(x, 7.8, !!cell.bold, fit(cell.text, 7.8, cw[0]! - 4, !!cell.bold), COLOR.ink);
      else d.right(x + cw[i]!, 7.8, !!cell.bold, cell.text, COLOR.ink);
    });
    d.y = yy + 15;
  }
  d.y += 4;
  if (e.distribution.flag) {
    const fw = textWidth(e.distribution.flag, 7.2, true) + 12;
    d.box(LEFT + 12, d.y - 2, fw, 14, null, BAND.LOW.fg, 3, 0.8);
    const keep = d.y;
    d.y += 1.5;
    d.line(LEFT + 18, 7.2, true, e.distribution.flag, BAND.LOW.fg);
    d.y = keep;
    d.para(LEFT + 18 + fw, half - fw - 30, e.distribution.note, 7, false, COLOR.muted, 1.25);
  } else d.para(LEFT + 12, half - 24, e.distribution.note, 7, false, COLOR.muted, 1.25);

  // Responses and exclusions (right).
  const rx = LEFT + half + 12;
  d.box(rx, top, half, boxH, COLOR.white, COLOR.border, 6);
  d.y = top + 12;
  d.cardTitle(rx + 12, e.responses.title, 9.5);
  d.y = top + 32;
  for (const row of e.responses.rows) {
    const yy = d.y;
    if (respTwoLine(row)) {
      d.line(rx + 12, 7.8, false, row.label, COLOR.ink);
      d.y = yy + 13;
      d.para(rx + 12, half - 24, row.value, 7.8, true, COLOR.ink, 1.3);
      d.y += 3;
      continue;
    }
    d.line(rx + 12, 7.8, false, row.label, COLOR.ink);
    d.y = yy;
    d.right(rx + half - 12, 7.8, true, row.value, COLOR.ink);
    d.y = yy + 15;
  }
  // Gender bar.
  const total = e.responses.gender.reduce((s, g) => s + g.count, 0);
  const gx = rx + 12;
  const gw = half - 24;
  const gTop = d.y + 2;
  const gColors = [COLOR.blue, hex('#3f8a78'), hex('#8a959c')];
  let acc = 0;
  e.responses.gender.forEach((g, i) => {
    if (!total || !g.count) return;
    const w = (gw * g.count) / total;
    d.bar(gx + acc, gTop, Math.max(1, w - 1), 14, gColors[i]!);
    const label = `${g.label} ${g.count}`;
    if (textWidth(label, 6.8, true) < w - 4) {
      const keep = d.y;
      d.y = gTop + 3.5;
      d.line(gx + acc + (w - textWidth(label, 6.8, true)) / 2, 6.8, true, label, COLOR.white);
      d.y = keep;
    }
    acc += w;
  });
  if (!total) d.bar(gx, gTop, gw, 14, COLOR.track);
  d.y = gTop + 20;
  d.line(rx + 12, 7.2, false, fit(e.responses.age, 7.2, half - 24), COLOR.muted);
  d.y += 12;
  d.para(rx + 12, half - 24, e.responses.note, 6.8, false, COLOR.muted, 1.25);
  d.y = top + boxH + 12;

  // Fit to publish (left, wide) + collect next (right).
  const fitW = CONTENT_W - 190;
  const fTop = d.y;
  d.cardTitle(LEFT, e.fit.title, 10);
  d.y = fTop + 18;
  table(d, e.fit.columns, e.fit.rows, {
    w: fitW,
    widths: [0.34, 0.24, 0.42],
    header: 'teal',
    size: 7.8,
  });
  const fitEnd = d.y;
  const nx = LEFT + fitW + 12;
  const nw = CONTENT_W - fitW - 12;
  const nextH = 30 + e.next.items.reduce((h, it) => h + d.measure(it, 7.8, nw - 34) + 4, 0);
  d.box(nx, fTop, nw, nextH, COLOR.panel, null, 6);
  d.y = fTop + 12;
  d.cardTitle(nx + 12, e.next.title, 9.5);
  d.y = fTop + 30;
  e.next.items.forEach((it, i) => {
    d.line(nx + 12, 7.8, true, `${i + 1}.`, COLOR.tealText);
    d.para(nx + 26, nw - 34, it, 7.8, false, COLOR.ink, 1.3);
    d.y += 4;
  });
  d.y = Math.max(fitEnd, fTop + nextH) + 12;

  // NCNP report: the studies combined, with their reliability.
  if (e.studies) {
    d.ensure(70);
    d.cardTitle(LEFT, e.studies.title, 10);
    d.y += 18;
    table(d, e.studies.columns, e.studies.rows, {
      widths: [0.4, 0.28, 0.16, 0.16],
      header: 'teal',
      size: 7.8,
    });
    d.para(LEFT, CONTENT_W, e.studies.rule, 7, false, COLOR.muted, 1.3);
    d.y += 10;
  }

  // Documented need cards.
  for (const card of e.cards) needCard(d, card);

  // Audit trail.
  d.ensure(38);
  d.bar(LEFT, d.y, CONTENT_W, 0.6, COLOR.border);
  d.y += 8;
  const aw = CONTENT_W / e.audit.length;
  const aTop = d.y;
  e.audit.forEach((a, i) => {
    const x = LEFT + i * aw;
    d.y = aTop;
    d.line(x, 7.5, true, a.label, COLOR.ink);
    d.y = aTop + 11;
    d.para(x, aw - 10, a.value, 7, false, COLOR.muted, 1.3);
  });
  d.y = aTop + 34;
}

function needCard(d: Doc, card: CoreView['evidence']['cards'][number]): void {
  // Three fields to a row with tight spacing: every field stays, and a page
  // holds about five cards instead of three.
  const COLS = 3;
  const colW = (CONTENT_W - 24 - (COLS - 1) * 12) / COLS;
  const rows = Math.ceil(card.fields.length / COLS);
  const rowFields = (i: number) => card.fields.slice(i * COLS, i * COLS + COLS);
  const rowH = (i: number) =>
    Math.max(...rowFields(i).map((f) => 9 + d.measure(f.value, 7.8, colW, true, 1.25))) + 3;
  const fieldsH = Array.from({ length: rows }, (_, i) => rowH(i)).reduce((a, b) => a + b, 0);
  const h = 30 + fieldsH + (card.footer ? d.measure(card.footer, 7.2, CONTENT_W - 24) : 0) + 4;
  d.ensure(h + 6);
  // First registration wins, so this marks the page of the first card.
  d.pdf.anchor('part-cards');
  const top = d.y;
  d.box(LEFT, top, CONTENT_W, h, COLOR.goldBg, COLOR.gold, 6, 1);
  d.bar(LEFT + 1, top + 22, CONTENT_W - 2, 0.6, hex('#efe3b4'));
  d.y = top + 7;
  d.line(LEFT + 12, 10, true, card.title, COLOR.tealText);
  const tw = textWidth(card.title, 10, true);
  d.y = top + 9;
  d.line(LEFT + 18 + tw, 7.2, false, fit(card.forWhom, 7.2, CONTENT_W - tw - 150), COLOR.muted);
  const sw = textWidth(card.status, 7.2, true) + 14;
  d.box(R - 12 - sw, top + 5, sw, 13, card.eligible ? TONE.low : BAND.LOW.fg, null, 3);
  d.y = top + 8;
  d.line(R - 12 - sw + 7, 7.2, true, card.status, COLOR.white);
  let y = top + 29;
  for (let i = 0; i < rows; i++) {
    rowFields(i).forEach((f, j) => {
      const x = LEFT + 12 + j * (colW + 12);
      d.y = y;
      d.line(x, 6.8, false, f.label, COLOR.muted);
      d.y = y + 9;
      d.para(x, colW, f.value, 7.8, true, COLOR.ink, 1.25);
    });
    y += rowH(i);
  }
  d.y = y;
  if (card.footer) d.para(LEFT + 12, CONTENT_W - 24, card.footer, 7.2, false, COLOR.muted, 1.3);
  d.y = top + h + 5;
}

// ───────────────────────── entry ─────────────────────────

type PartAnchor = 'part-where' | 'part-design' | 'part-evidence' | 'part-cards';
const PART_ANCHORS: readonly PartAnchor[] = [
  'part-where',
  'part-design',
  'part-evidence',
  'part-cards',
];

function draw(view: CoreView, pages: Partial<Record<PartAnchor, number>>): Doc {
  const d = new Doc(view, pages);
  pageSummary(d);
  if (view.output === 'FULL') {
    pageWhere(d);
    pageDesign(d);
    pageEvidence(d);
  }
  d.footers();
  return d;
}

export function renderCoreNeedsPdf(view: CoreView): Buffer {
  if (view.output !== 'FULL') return draw(view, {}).pdf.build();
  // Two passes: the first finds where each section starts, the second writes
  // those pages into the page-1 guide. The guide's height does not depend on
  // its text, so the second pass paginates exactly like the first.
  const first = draw(view, {});
  const pages: Partial<Record<PartAnchor, number>> = {};
  for (const a of PART_ANCHORS) {
    const p = first.pdf.anchorPage(a);
    if (p != null) pages[a] = p;
  }
  return draw(view, pages).pdf.build();
}
