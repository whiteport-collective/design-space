// generate-pdf v3: Markdown → A4 PDF (Roboto TTF, Swedish chars, tables)
// POST { type: "ruttplan" | "packlista" | "ekonomi", title?: string, content: string }
// Returns application/pdf
// verify_jwt: false — called by Loreen without user JWT

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { PDFDocument, rgb, PDFPage, PDFFont } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

// ─── Page constants ──────────────────────────────────────────────────────────

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CW = PAGE_W - 2 * MARGIN; // 515.28

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

// ─── Font cache (fetched once per worker) ────────────────────────────────────
// Roboto TTF from Google Fonts CDN (fonts.gstatic.com).
// Full font including all Latin glyphs — ä ö å Ä Ö Å etc.
// URLs from: https://fonts.googleapis.com/css?family=Roboto:400,700 (UA: Mozilla/4.0)

// Latin + Latin-ext subset — verified contains ä ö å (U+00E4, U+00F6, U+00E5 in cmap)
// From: googleapis.com/css?family=Roboto:400,700&subset=latin,latin-ext (UA: Mozilla/4.0)
const FONT_REG_URL = "https://fonts.gstatic.com/s/roboto/v51/KFOMCnqEu92Fr1ME7kSn66aGLdTylUAMQXC89YmC2DPNWubEbVmaiA8.ttf";
const FONT_BOLD_URL = "https://fonts.gstatic.com/s/roboto/v51/KFOMCnqEu92Fr1ME7kSn66aGLdTylUAMQXC89YmC2DPNWuYjalmaiA8.ttf";

interface FontCache {
  regular: Uint8Array;
  bold: Uint8Array;
}
let fontCache: FontCache | null = null;

async function getFonts(): Promise<FontCache> {
  if (fontCache) return fontCache;
  const [regRes, boldRes] = await Promise.all([
    fetch(FONT_REG_URL),
    fetch(FONT_BOLD_URL),
  ]);
  if (!regRes.ok || !boldRes.ok) {
    throw new Error(`Font fetch failed: reg=${regRes.status} bold=${boldRes.status}`);
  }
  const [reg, bold] = await Promise.all([regRes.arrayBuffer(), boldRes.arrayBuffer()]);
  fontCache = { regular: new Uint8Array(reg), bold: new Uint8Array(bold) };
  return fontCache;
}

// ─── Text normalisation ───────────────────────────────────────────────────────
// Inter covers full Latin Extended — only emoji need replacement.

function norm(text: string): string {
  return text
    .replace(/\u2713/g, "OK")   // ✓ check mark (not in Inter Latin)
    .replace(/\u2714/g, "OK")   // ✔
    .replace(/\u2715/g, "x")    // ✕
    .replace(/\u2615/g, "[rast]")             // ☕
    .replace(/\u{1F319}/gu, "[overnattning]") // 🌙
    .replace(/\u{1F3E0}/gu, "[hemkomst]")     // 🏠
    .replace(/\u{1F6B6}/gu, "[gang]")         // 🚶
    .replace(/\u{1F697}/gu, "[bil]");         // 🚗
  // Inter supports ä ö å — em-dash — and other Latin Extended chars natively
}

function stripBold(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1");
}

// ─── Markdown parser ──────────────────────────────────────────────────────────

interface Block {
  type: "h1" | "h2" | "h3" | "hr" | "table" | "para" | "bold-para";
  text?: string;
  rows?: string[][];
}

function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split("\n");
  let i = 0;

  while (i < lines.length) {
    const t = lines[i].trim();

    if (!t) { i++; continue; }

    if (t.startsWith("# ") && !t.startsWith("## ")) {
      blocks.push({ type: "h1", text: norm(t.slice(2)) });
      i++; continue;
    }
    if (t.startsWith("## ")) {
      blocks.push({ type: "h2", text: norm(t.slice(3)) });
      i++; continue;
    }
    if (t.startsWith("### ")) {
      blocks.push({ type: "h3", text: norm(t.slice(4)) });
      i++; continue;
    }
    if (t === "---" || t === "***" || /^─+$/.test(t)) {
      blocks.push({ type: "hr" });
      i++; continue;
    }
    if (t.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const row = lines[i].trim();
        if (/^\|[\s\-:|]+\|$/.test(row)) { i++; continue; }
        const cells = row
          .split("|")
          .map(c => norm(stripBold(c.trim())))
          .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
        rows.push(cells);
        i++;
      }
      if (rows.length > 0) blocks.push({ type: "table", rows });
      continue;
    }
    if (/^\*\*.+\*\*$/.test(t)) {
      blocks.push({ type: "bold-para", text: norm(stripBold(t)) });
      i++; continue;
    }
    blocks.push({ type: "para", text: norm(stripBold(t)) });
    i++;
  }

  return blocks;
}

// ─── Drawing context ──────────────────────────────────────────────────────────

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  reg: PDFFont;
  bold: PDFFont;
  y: number; // distance from page TOP (increases downward)
}

const pdfY = (fromTop: number) => PAGE_H - fromTop;

function ensureSpace(ctx: Ctx, need: number): Ctx {
  if (ctx.y + need > PAGE_H - MARGIN) {
    const page = ctx.doc.addPage([PAGE_W, PAGE_H]);
    return { ...ctx, page, y: MARGIN };
  }
  return ctx;
}

function drawStr(
  ctx: Ctx,
  text: string,
  x: number,
  fromTop: number,
  size: number,
  font: PDFFont,
  color = rgb(0.1, 0.1, 0.1),
) {
  if (!text) return;
  ctx.page.drawText(text, {
    x,
    y: pdfY(fromTop + size * 0.85),
    size,
    font,
    color,
  });
}

// ─── Text wrapping ────────────────────────────────────────────────────────────

function wrapText(text: string, font: PDFFont, maxW: number, size: number): string[] {
  if (!text) return [""];
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxW && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// ─── Table drawing ────────────────────────────────────────────────────────────

function drawTable(ctx: Ctx, rows: string[][], type: string): Ctx {
  if (!rows.length) return ctx;

  const FS = 8;
  const PX = 4;
  const PY = 3;
  const LH = FS * 1.5;

  const colCount = rows[0].length;

  let colW: number[];
  if (type === "ruttplan" && colCount === 5) {
    const fixed = 58 + 90 + 32 + 56;
    colW = [58, 90, CW - fixed, 32, 56];
  } else if (type === "packlista" && colCount === 8) {
    const fixed = 68 + 65 + 42 + 26 + 22 + 30 + 40;
    colW = [68, CW - fixed, 65, 42, 26, 22, 30, 40];
  } else {
    const w = Math.floor(CW / colCount);
    colW = Array(colCount).fill(w);
    colW[colCount - 1] = CW - w * (colCount - 1);
  }

  const processedRows = rows.map((row, ri) => {
    const font = ri === 0 ? ctx.bold : ctx.reg;
    const cellLines = row.map((cell, ci) =>
      wrapText(cell, font, (colW[ci] ?? 40) - 2 * PX, FS)
    );
    const nLines = Math.max(...cellLines.map(l => l.length), 1);
    const rowH = nLines * LH + 2 * PY;
    return { cellLines, rowH };
  });

  for (let r = 0; r < processedRows.length; r++) {
    const { cellLines, rowH } = processedRows[r];
    ctx = ensureSpace(ctx, rowH);

    const isHeader = r === 0;
    const isBoldRow = isHeader || rows[r].some(c => /totalt/i.test(c));
    const font = isBoldRow ? ctx.bold : ctx.reg;

    if (isHeader) {
      ctx.page.drawRectangle({
        x: MARGIN,
        y: pdfY(ctx.y + rowH),
        width: CW,
        height: rowH,
        color: rgb(0.91, 0.91, 0.91),
        borderWidth: 0,
      });
    }

    let xCur = MARGIN;
    for (let c = 0; c < colCount; c++) {
      const cw = colW[c] ?? 40;

      ctx.page.drawRectangle({
        x: xCur,
        y: pdfY(ctx.y + rowH),
        width: cw,
        height: rowH,
        borderColor: rgb(0.78, 0.78, 0.78),
        borderWidth: 0.4,
        opacity: 0,
        borderOpacity: 1,
      });

      const lines = cellLines[c] ?? [""];
      lines.forEach((line, li) => {
        drawStr(ctx, line, xCur + PX, ctx.y + PY + li * LH, FS, font);
      });

      xCur += cw;
    }

    ctx = { ...ctx, y: ctx.y + rowH };
  }

  return { ...ctx, y: ctx.y + 8 };
}

// ─── Main PDF generator ───────────────────────────────────────────────────────

async function generatePDF(type: string, content: string): Promise<Uint8Array> {
  const fonts = await getFonts();

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const reg = await doc.embedFont(fonts.regular);
  const bold = await doc.embedFont(fonts.bold);
  const page = doc.addPage([PAGE_W, PAGE_H]);

  let ctx: Ctx = { doc, page, reg, bold, y: MARGIN };

  const blocks = parseMarkdown(content);

  for (const block of blocks) {
    switch (block.type) {
      case "h1": {
        ctx = ensureSpace(ctx, 26);
        drawStr(ctx, block.text!, MARGIN, ctx.y, 16, ctx.bold, rgb(0.05, 0.05, 0.05));
        ctx = { ...ctx, y: ctx.y + 23 };
        break;
      }
      case "h2": {
        ctx = ensureSpace(ctx, 22);
        ctx = { ...ctx, y: ctx.y + 8 };
        drawStr(ctx, block.text!, MARGIN, ctx.y, 12, ctx.bold, rgb(0.15, 0.15, 0.15));
        ctx = { ...ctx, y: ctx.y + 18 };
        break;
      }
      case "h3": {
        ctx = ensureSpace(ctx, 16);
        drawStr(ctx, block.text!, MARGIN, ctx.y, 10, ctx.bold, rgb(0.25, 0.25, 0.25));
        ctx = { ...ctx, y: ctx.y + 14 };
        break;
      }
      case "hr": {
        ctx = ensureSpace(ctx, 12);
        ctx.page.drawLine({
          start: { x: MARGIN, y: pdfY(ctx.y + 5) },
          end: { x: PAGE_W - MARGIN, y: pdfY(ctx.y + 5) },
          thickness: 0.5,
          color: rgb(0.75, 0.75, 0.75),
        });
        ctx = { ...ctx, y: ctx.y + 12 };
        break;
      }
      case "table": {
        ctx = drawTable(ctx, block.rows!, type);
        break;
      }
      case "bold-para": {
        ctx = ensureSpace(ctx, 15);
        drawStr(ctx, block.text!, MARGIN, ctx.y, 9, ctx.bold);
        ctx = { ...ctx, y: ctx.y + 14 };
        break;
      }
      case "para": {
        ctx = ensureSpace(ctx, 15);
        drawStr(ctx, block.text!, MARGIN, ctx.y, 9, ctx.reg, rgb(0.2, 0.2, 0.2));
        ctx = { ...ctx, y: ctx.y + 13 };
        break;
      }
    }
  }

  return await doc.save();
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS });
  }

  let body: { type?: string; title?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { type = "ruttplan", title, content } = body;

  if (!content) {
    return new Response(JSON.stringify({ error: "content is required" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    const pdfBytes = await generatePDF(type, content);

    const safeName = (title ?? type)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s\-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 80);

    return new Response(pdfBytes, {
      headers: {
        ...CORS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeName || type}.pdf"`,
        "Content-Length": String(pdfBytes.byteLength),
      },
    });
  } catch (err) {
    console.error("[generate-pdf] error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
