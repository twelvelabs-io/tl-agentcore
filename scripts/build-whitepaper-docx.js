#!/usr/bin/env node
// Build whitepaper-v2.docx from whitepaper-v2.md.
//
// Markdown subset handled:
//   - ATX headings (#, ##, ###)
//   - Paragraphs (with **bold**, *italic*, `code`, [link](url))
//   - Bullet lists (- )
//   - Numbered lists (1. )
//   - Tables (| ... |)
//   - Images (![alt](path)) — embedded if the file exists, otherwise a placeholder caption
//   - Horizontal rules (---)
//   - Bold/italic/code inline
//
// Page setup: US Letter, 1-inch margins, Arial body, real heading styles.

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
  AlignmentType, HeadingLevel, LevelFormat, BorderStyle, WidthType, ShadingType,
  PageOrientation, ExternalHyperlink,
  CommentRangeStart, CommentRangeEnd, CommentReference,
} = require("docx");

const MD_PATH    = path.resolve(__dirname, "../sessions/youthful-laughing-newton/mnt/tl-agentcore/docs/whitepaper-v2.md");
const OUT_PATH   = path.resolve(__dirname, "../sessions/youthful-laughing-newton/mnt/tl-agentcore/docs/whitepaper-v2.docx");
const DIAGRAM_DIR = path.resolve(__dirname, "../sessions/youthful-laughing-newton/mnt/tl-agentcore/docs/diagrams");

const md = fs.readFileSync(MD_PATH, "utf-8");

// ─── Inline runs: bold / italic / code / link ─────────────────────────────
function inlineRuns(text) {
  // Tokenize: **bold**, *italic*, `code`, [link](url), plain text.
  const runs = [];
  let i = 0;
  while (i < text.length) {
    // Bold
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        runs.push(new TextRun({ text: text.slice(i + 2, end), bold: true, font: "Arial" }));
        i = end + 2; continue;
      }
    }
    // Italic
    if (text[i] === "*" && text[i+1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1) {
        runs.push(new TextRun({ text: text.slice(i + 1, end), italics: true, font: "Arial" }));
        i = end + 1; continue;
      }
    }
    // Inline code
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        runs.push(new TextRun({ text: text.slice(i + 1, end), font: "Consolas", color: "8B5CF6" }));
        i = end + 1; continue;
      }
    }
    // Link
    if (text[i] === "[") {
      const close = text.indexOf("](", i);
      const end = close > 0 ? text.indexOf(")", close) : -1;
      if (close > 0 && end > close) {
        const label = text.slice(i + 1, close);
        const url = text.slice(close + 2, end);
        runs.push(new ExternalHyperlink({
          children: [new TextRun({ text: label, style: "Hyperlink", font: "Arial" })],
          link: url,
        }));
        i = end + 1; continue;
      }
    }
    // Plain run until next inline marker
    let j = i;
    while (j < text.length && text[j] !== "*" && text[j] !== "`" && text[j] !== "[") j++;
    if (j > i) {
      runs.push(new TextRun({ text: text.slice(i, j), font: "Arial" }));
      i = j;
    } else {
      // Lone marker, treat as literal
      runs.push(new TextRun({ text: text[i], font: "Arial" }));
      i++;
    }
  }
  return runs;
}

// ─── Block parsing ────────────────────────────────────────────────────────
function parseBlocks(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines
    if (!line.trim()) { i++; continue; }
    // Horizontal rule
    if (/^---+$/.test(line.trim())) { blocks.push({ type: "hr" }); i++; continue; }
    // Heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, text: h[2] });
      i++; continue;
    }
    // Image
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      blocks.push({ type: "image", alt: img[1], path: img[2] });
      i++; continue;
    }
    // Table: starts with `|`
    if (line.trim().startsWith("|")) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "table", lines: tableLines });
      continue;
    }
    // Bullet list
    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) {
        let item = lines[i].slice(2);
        i++;
        // Continuation lines (4-space-indented)
        while (i < lines.length && /^ {2,}\S/.test(lines[i])) {
          item += " " + lines[i].trim();
          i++;
        }
        items.push(item);
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    // Numbered list
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        let item = lines[i].replace(/^\d+\.\s/, "");
        i++;
        while (i < lines.length && /^ {2,}\S/.test(lines[i])) {
          item += " " + lines[i].trim();
          i++;
        }
        items.push(item);
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    // Paragraph
    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|---|!\[|\||- |\d+\.\s)/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      blocks.push({ type: "paragraph", text: paraLines.join(" ") });
    }
  }
  return blocks;
}

// ─── Table parsing ─────────────────────────────────────────────────────────
function parseTable(tableLines) {
  // Skip the separator row (|---|---|---|)
  const rows = tableLines
    .map(l => l.trim())
    .filter(l => !/^\|[-:\s|]+\|$/.test(l))
    .map(l => l.replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
  return { header: rows[0], rows: rows.slice(1) };
}

// ─── PNG dimensions: parse from IHDR chunk (bytes 16-23) ──────────────────
function pngDimensions(buf) {
  // PNG signature is 8 bytes; IHDR length+type are next 8 bytes (12-19);
  // then width (4 bytes) and height (4 bytes) at offsets 16 and 20.
  if (buf.length < 24) return null;
  // Validate PNG signature
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  const width  = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

// ─── Image: embed if file exists, else placeholder ────────────────────────
// Scaling rule: cap the longer dimension at MAX_WIDTH_PX (page-content
// width at 96 dpi ≈ 624 px for US Letter w/ 1" margins); preserve aspect
// ratio. Tall diagrams stay readable; wide LR diagrams fill the page width.
const MAX_WIDTH_PX  = 600; // visual width cap
const MAX_HEIGHT_PX = 720; // also cap height so portrait diagrams don't run off-page
function fitToBox(srcW, srcH) {
  const wRatio = MAX_WIDTH_PX  / srcW;
  const hRatio = MAX_HEIGHT_PX / srcH;
  const r = Math.min(wRatio, hRatio, 1); // never upscale beyond source
  return { width: Math.round(srcW * r), height: Math.round(srcH * r) };
}

function imageBlock(alt, relPath, figureNumber) {
  // Resolve image path. The MD uses `diagrams/foo.png`; map to absolute.
  const abs = path.resolve(DIAGRAM_DIR, path.basename(relPath));
  if (fs.existsSync(abs)) {
    const buf = fs.readFileSync(abs);
    const dims = pngDimensions(buf) || { width: 1200, height: 800 };
    const { width, height } = fitToBox(dims.width, dims.height);
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 240, after: 240 },
      children: [new ImageRun({
        type: "png",
        data: buf,
        transformation: { width, height },
        altText: { title: alt, description: alt, name: path.basename(relPath) },
      })],
    });
  } else {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 240, after: 240 },
      shading: { fill: "F3F4F6", type: ShadingType.CLEAR },
      children: [new TextRun({
        text: `[Figure ${figureNumber} · ${alt} — insert ${path.basename(relPath)} here]`,
        italics: true, color: "6B7280", font: "Arial",
      })],
    });
  }
}

// ─── Build docx ────────────────────────────────────────────────────────────
const CONTENT_WIDTH = 9360; // US Letter, 1-inch margins (12240 - 2880)

function buildTable(tbl) {
  const numCols = tbl.header.length;
  const colWidth = Math.floor(CONTENT_WIDTH / numCols);
  const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" };
  const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

  const buildCell = (text, isHeader = false) =>
    new TableCell({
      borders: cellBorders,
      width: { size: colWidth, type: WidthType.DXA },
      shading: isHeader ? { fill: "EEF2FF", type: ShadingType.CLEAR } : undefined,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({
        spacing: { before: 0, after: 0 },
        children: isHeader
          ? [new TextRun({ text, bold: true, font: "Arial", size: 20 })]
          : inlineRuns(text),
      })],
    });

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: new Array(numCols).fill(colWidth),
    rows: [
      new TableRow({ children: tbl.header.map(h => buildCell(h, true)), tableHeader: true }),
      ...tbl.rows.map(r =>
        new TableRow({ children: r.map(c => buildCell(c, false)) })),
    ],
  });
}

// ─── Walk blocks and emit ──────────────────────────────────────────────────
const blocks = parseBlocks(md);
const children = [];
let figureNumber = 0;
let imagesEmbedded = 0;
let imagesPlaceholder = 0;

// Comments to attach to the document. Each entry corresponds to a Word
// margin comment; `id` is the unique comment id, `anchorIndex` is the
// children[] index of the paragraph the comment is anchored on.
const comments = [];
let nextCommentId = 0;

// Markdown markers:
//   [Note - ...]      → inline body placeholder (amber, italic+bold) — needs work, not yet written
//   [ADD ...]         → inline body placeholder (e.g., screenshots)
//   [Comment - ...]   → Word margin comment attached to the previous emitted element
const placeholderMarker = b => b.type === "paragraph" && /^\[(Note|ADD|TODO|TBD)\b[^\]]*\]\s*$/.test(b.text);
const commentMarker     = b => b.type === "paragraph" && /^\[Comment\b[^\]]*\]\s*$/.test(b.text);

function attachCommentToPrevious(commentBody) {
  // Walk children backwards to find the most-recent element flagged as
  // eligible for comment anchoring. Wrap its inline runs with the
  // CommentRangeStart/End markers, then push the comment payload.
  let anchorIdx = -1;
  for (let j = children.length - 1; j >= 0; j--) {
    if (children[j].__commentEligible) { anchorIdx = j; break; }
  }
  if (anchorIdx < 0) return false; // no anchor; caller may fall back
  const cid = nextCommentId++;
  const orig = children[anchorIdx];
  const wrapped = new Paragraph(Object.assign({}, orig.__origOpts, {
    children: [
      new CommentRangeStart(cid),
      ...(orig.__origRuns || []),
      new CommentRangeEnd(cid),
      new TextRun({ children: [new CommentReference(cid)] }),
    ],
  }));
  // Preserve the original eligibility / stashed runs in case another comment
  // wants to attach to the same element (rare but allowed).
  wrapped.__commentEligible = true;
  wrapped.__origOpts = orig.__origOpts;
  wrapped.__origRuns = orig.__origRuns;
  children[anchorIdx] = wrapped;
  comments.push({
    id: cid,
    author: "Claude",
    date: new Date(),
    children: [new Paragraph({ children: [new TextRun({ text: commentBody, font: "Arial", size: 20 })] })],
  });
  return true;
}

for (let bi = 0; bi < blocks.length; bi++) {
  const b = blocks[bi];

  // [Comment - ...] is handled inline: attach to the most recent eligible element.
  if (commentMarker(b)) {
    const body = b.text.replace(/^\[Comment\s*-?\s*/, '').replace(/\]\s*$/, '').trim();
    const ok = attachCommentToPrevious(body);
    if (!ok) {
      // No anchor — render the comment as a body note so it isn't lost.
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 200 },
        shading: { fill: "DBEAFE", type: ShadingType.CLEAR },
        children: [new TextRun({ text: `[orphan comment] ${body}`, italics: true, color: "1E40AF", font: "Arial", size: 20 })],
      }));
    }
    continue;
  }

  switch (b.type) {
    case "heading": {
      if (b.level === 1) {
        // Title — use a large centered heading
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 120 },
          children: [new TextRun({ text: b.text, bold: true, font: "Arial", size: 40 })],
        }));
      } else {
        const headingLevel = b.level === 2 ? HeadingLevel.HEADING_1
                          : b.level === 3 ? HeadingLevel.HEADING_2
                          : HeadingLevel.HEADING_3;
        children.push(new Paragraph({
          heading: headingLevel,
          spacing: { before: 360, after: 120 },
          children: [new TextRun({ text: b.text, bold: true, font: "Arial" })],
        }));
      }
      break;
    }
    case "paragraph": {
      // Bold subtitle handling: a single ** ... ** paragraph
      const onlyBold = b.text.match(/^\*\*([^*]+)\*\*$/);
      // [Note/ADD/TODO/TBD] → inline body placeholders (amber).
      const placeholder = placeholderMarker(b);
      if (onlyBold) {
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 360 },
          children: [new TextRun({ text: onlyBold[1], italics: true, font: "Arial", size: 24, color: "6B7280" })],
        }));
      } else if (placeholder) {
        const opts = {
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 200, line: 280 },
          shading: { fill: "FEF3C7", type: ShadingType.CLEAR }, // amber-100 background
        };
        const runs = [new TextRun({
          text: b.text,
          italics: true, bold: true, font: "Arial", size: 20, color: "92400E", // amber-800 ink
        })];
        const para = new Paragraph(Object.assign({}, opts, { children: runs }));
        para.__commentEligible = true;
        para.__origOpts = opts;
        para.__origRuns = runs;
        children.push(para);
      } else {
        const opts = { spacing: { before: 60, after: 120, line: 320 } };
        const runs = inlineRuns(b.text);
        const para = new Paragraph(Object.assign({}, opts, { children: runs }));
        para.__commentEligible = true;
        para.__origOpts = opts;
        para.__origRuns = runs;
        children.push(para);
      }
      break;
    }
    case "ul": {
      for (const item of b.items) {
        children.push(new Paragraph({
          numbering: { reference: "bullets", level: 0 },
          spacing: { before: 40, after: 40, line: 320 },
          children: inlineRuns(item),
        }));
      }
      break;
    }
    case "ol": {
      for (const item of b.items) {
        children.push(new Paragraph({
          numbering: { reference: "numbers", level: 0 },
          spacing: { before: 40, after: 40, line: 320 },
          children: inlineRuns(item),
        }));
      }
      break;
    }
    case "table": {
      const tbl = parseTable(b.lines);
      children.push(buildTable(tbl));
      children.push(new Paragraph({ spacing: { before: 60, after: 60 }, children: [new TextRun("")] }));
      break;
    }
    case "image": {
      figureNumber++;
      const abs = path.resolve(DIAGRAM_DIR, path.basename(b.path));
      if (fs.existsSync(abs)) imagesEmbedded++; else imagesPlaceholder++;
      children.push(imageBlock(b.alt, b.path, figureNumber));
      // Caption
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 240 },
        children: [new TextRun({
          text: `Figure ${figureNumber} · ${b.alt}`,
          italics: true, color: "6B7280", font: "Arial", size: 18,
        })],
      }));
      break;
    }
    case "hr": {
      // skip — section breaks are handled by heading spacing
      break;
    }
  }
}

const doc = new Document({
  creator: "tl-agentcore",
  title: "Building Agentic Highlight-Reel Pipelines on AWS",
  comments: { children: comments },
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } }, // 11pt body
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial", color: "111827" },
        paragraph: { spacing: { before: 480, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: "Arial", color: "1F2937" },
        paragraph: { spacing: { before: 360, after: 120 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 22, bold: true, font: "Arial", color: "374151" },
        paragraph: { spacing: { before: 240, after: 100 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [
        { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
      ]},
      { reference: "numbers", levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
      ]},
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840, orientation: PageOrientation.PORTRAIT },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    children,
  }],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(OUT_PATH, buf);
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  blocks: ${blocks.length}, body elements: ${children.length}`);
  console.log(`  images embedded: ${imagesEmbedded}, placeholders: ${imagesPlaceholder}`);
  console.log(`  size: ${buf.length} bytes`);
}).catch(e => {
  console.error("docx pack failed:", e);
  process.exit(1);
});
