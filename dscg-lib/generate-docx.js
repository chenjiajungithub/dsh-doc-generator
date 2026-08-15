#!/usr/bin/env node
/**
 * generate-docx.js
 * ----------------
 * Renders Markdown content into a new .docx file, inheriting the default font
 * and size from a source template (when provided).
 *
 * Usage (called by the dsh-doc-generator Host plugin):
 *   node generate-docx.js <specPath>
 *
 * specPath JSON shape:
 *   {
 *     "content": "# Title\n\nSome **markdown** here...",   // Markdown source
 *     "templatePath": "/abs/template.docx",                 // optional, for styling
 *     "outputPath": "/abs/out/weekly_report.docx"
 *   }
 *
 * stdout JSON:
 *   { ok: true, outputPath: "..." }
 * on error:
 *   { ok: false, error: "..." }
 */

const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')

/** Load `docx` from an optional depsRoot (whose node_modules has it). */
let _docx = null
function loadDocx(depsRoot) {
  if (_docx) return _docx
  let req = require
  if (depsRoot) {
    const base = path.isAbsolute(depsRoot) ? depsRoot : path.resolve(process.cwd(), depsRoot)
    req = createRequire(path.join(base, 'noop.cjs'))
  }
  _docx = req('docx')
  return _docx
}

// Minimal Markdown block parser: supports #..###### headings, `-` / `*` / `1.`
// lists, blank-line separated paragraphs, blockquotes, **bold**, *italic*,
// `code`, and [link](url) inline spans. Unsupported constructs are kept as
// plain text so nothing is lost.
function parseMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '') { i++; continue }

    // Headings
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length, text: inline(h[2]) })
      i++; continue
    }
    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const quote = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++ }
      blocks.push({ kind: 'paragraph', text: inline(quote.join(' ')) })
      continue
    }
    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items = []
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) { items.push(inline(lines[i].trim().replace(/^[-*+]\s+/, ''))); i++ }
      blocks.push({ kind: 'bulletList', items })
      continue
    }
    // Ordered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items = []
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) { items.push(inline(lines[i].trim().replace(/^\d+[.)]\s+/, ''))); i++ }
      blocks.push({ kind: 'numberedList', items })
      continue
    }
    // Fenced code block
    if (/^```/.test(trimmed)) {
      const codeLines = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) { codeLines.push(lines[i]); i++ }
      i++
      blocks.push({ kind: 'code', text: codeLines.join('\n') })
      continue
    }
    // Horizontal rule
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push({ kind: 'horizontalRule' })
      i++; continue
    }
    // Plain paragraph (gather consecutive non-empty, non-special lines)
    const para = [line.trim()]
    i++
    while (i < lines.length) {
      const t = lines[i].trim()
      if (t === '' || /^(#{1,6})\s+/.test(t) || /^[-*+]\s+/.test(t) || /^\d+[.)]\s+/.test(t) || /^>/.test(t) || /^```/.test(t)) break
      para.push(t); i++
    }
    blocks.push({ kind: 'paragraph', text: inline(para.join(' ')) })
  }
  return blocks
}

/** Parse inline Markdown spans (**bold**, *italic*, `code`, [text](url)). */
function inline(str) {
  // Code spans first so their content is not treated as markup.
  const tokens = []
  const codeRe = /`([^`]+)`/g
  let last = 0, cm
  while ((cm = codeRe.exec(str)) !== null) {
    if (cm.index > last) tokens.push(...rich(str.slice(last, cm.index)))
    tokens.push({ text: cm[1], code: true })
    last = cm.index + cm[0].length
  }
  if (last < str.length) tokens.push(...rich(str.slice(last)))
  return tokens
}

function rich(text) {
  const out = []
  // [label](url)
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g
  let last = 0, lm
  while ((lm = linkRe.exec(text)) !== null) {
    if (lm.index > last) out.push(richChars(text.slice(last, lm.index)))
    out.push({ text: lm[1], link: lm[2] })
    last = lm.index + lm[0].length
  }
  if (last < text.length) out.push(...richChars(text.slice(last)))
  return out.length ? out : [{ text: '' }]
}

function richChars(s) {
  // **bold** and *italic* within a plain segment (kept simple, non-nested).
  const out = []
  const spans = []
  const boldRe = /\*\*([^*]+)\*\*/g
  let last = 0, bm
  while ((bm = boldRe.exec(s)) !== null) {
    if (bm.index > last) spans.push({ text: s.slice(last, bm.index) })
    spans.push({ text: bm[1], bold: true })
    last = bm.index + bm[0].length
  }
  if (last < s.length) spans.push({ text: s.slice(last) })
  for (const sp of spans) {
    const itRe = /\*([^*]+)\*/g
    let il = 0, im, pushed = false
    while ((im = itRe.exec(sp.text)) !== null) {
      if (im.index > il) out.push({ text: sp.text.slice(il, im.index), bold: sp.bold })
      out.push({ text: im[1], bold: sp.bold, italic: true })
      il = im.index + im[0].length
      pushed = true
    }
    if (!pushed) out.push(sp)
    else if (il < sp.text.length) out.push({ text: sp.text.slice(il), bold: sp.bold })
  }
  return out
}

function paragraphChildren(tokens, TextRun) {
  return tokens.map((t) => {
    const props = {}
    if (t.bold) props.bold = true
    if (t.italic) props.italic = true
    if (t.code) props.font = 'Consolas'
    if (t.link) {
      return new TextRun({ text: t.text, bold: t.bold, italic: t.italic, underline: { type: 'single' }, color: '0563C1' })
    }
    return new TextRun({ text: t.text, ...props })
  })
}

function buildDoc(blocks, styles, depsRoot) {
  const docx = loadDocx(depsRoot)
  const { Document, Paragraph, TextRun, HeadingLevel, AlignmentType } = docx
  const children = []
  const defaultFont = styles.defaultFont || 'Calibri'
  const defaultSizePt = styles.defaultFontSizePt || 11
  const sizeHalf = Math.round(defaultSizePt * 2)

  for (const b of blocks) {
    if (b.kind === 'heading') {
      const levels = {
        1: { text: HeadingLevel.HEADING_1, size: defaultSizePt + 9 },
        2: { text: HeadingLevel.HEADING_2, size: defaultSizePt + 6 },
        3: { text: HeadingLevel.HEADING_3, size: defaultSizePt + 4 },
      }
      const lvl = levels[b.level] || { text: `Heading${Math.min(b.level, 6)}`, size: defaultSizePt + 2 }
      children.push(new Paragraph({
        heading: lvl.text,
        children: paragraphChildren(b.text, TextRun),
        spacing: { before: 240, after: 120 },
      }))
    } else if (b.kind === 'paragraph') {
      children.push(new Paragraph({
        children: paragraphChildren(b.text, TextRun),
        spacing: { after: 120, line: 360 },
      }))
    } else if (b.kind === 'bulletList') {
      for (const item of b.items) {
        children.push(new Paragraph({
          bullet: { level: 0 },
          children: paragraphChildren(item, TextRun),
          spacing: { after: 60 },
        }))
      }
    } else if (b.kind === 'numberedList') {
      b.items.forEach((item, idx) => {
        children.push(new Paragraph({
          children: paragraphChildren(item, TextRun),
          numbering: { reference: 'dsh-numbering', level: 0 },
          spacing: { after: 60 },
        }))
      })
    } else if (b.kind === 'code') {
      for (const line of b.text.split('\n')) {
        children.push(new Paragraph({
          children: [new TextRun({ text: line, font: 'Consolas', size: sizeHalf - 2 })],
          shading: { type: 'clear', fill: 'F2F2F2' },
        }))
      }
    } else if (b.kind === 'horizontalRule') {
      children.push(new Paragraph({
        text: '',
        border: { bottom: { color: 'CCCCCC', space: 1, style: 'single', size: 6 } },
      }))
    }
  }

  return new Document({
    creator: 'DeepSeek Harness - dsh-doc-generator',
    styles: {
      default: {
        run: { font: defaultFont, size: sizeHalf },
      },
    },
    numbering: {
      config: [
        {
          reference: 'dsh-numbering',
          levels: [
            { level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START },
          ],
        },
      ],
    },
    sections: [{ children }],
  })
}

function main() {
  const specPath = process.argv[2]
  if (!specPath) return fail('missing specPath argument')
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
  const content = spec.content
  const outputPath = spec.outputPath
  if (typeof content !== 'string' || content.trim() === '') return fail('spec.content (markdown) is required')
  if (!outputPath) return fail('spec.outputPath is required')

  const blocks = parseMarkdown(content)
  const styles = { defaultFont: spec.defaultFont, defaultFontSizePt: spec.defaultFontSizePt }
  const docx = loadDocx(spec.depsRoot)
  const doc = buildDoc(blocks, styles, spec.depsRoot)

  docx.Packer.toBuffer(doc)
    .then((buffer) => {
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true })
      fs.writeFileSync(outputPath, buffer)
      process.stdout.write(JSON.stringify({ ok: true, outputPath }))
    })
    .catch((err) => fail(err && err.message ? err.message : String(err)))
}

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }))
  process.exit(1)
}

main()
