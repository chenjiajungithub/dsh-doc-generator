#!/usr/bin/env node
/**
 * parse-template.js
 * ------------------
 * Reads a Word (.docx) template and emits a structured description of its:
 *   - placeholder tags (e.g. {{title}}, {{author}})
 *   - document outline (headings and their hierarchy)
 *   - inherited style rules (default font + size from the template)
 *
 * Usage (called by the dsh-doc-generator Host plugin):
 *   node parse-template.js <specPath>
 *
 * specPath points to a JSON file like:
 *   { "templatePath": "/abs/path/to/template.docx" }
 *
 * The script prints a single JSON document on stdout:
 *   { ok: true, placeholders: [...], outline: [...], styles: {...}, paragraphs: [...] }
 * On failure it prints:
 *   { ok: false, error: "message" }
 * and exits non-zero.
 */

const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')

/**
 * Load a third-party dependency (jszip/mammoth/docx) from an optional
 * depsRoot whose `node_modules` holds them, falling back to this script's own
 * module resolution. - `depsRoot` is the directory CONTAINING node_modules.
 */
let _require = require
function loadDeps(depsRoot) {
  if (depsRoot) {
    const base = path.isAbsolute(depsRoot) ? depsRoot : path.resolve(process.cwd(), depsRoot)
    _require = createRequire(path.join(base, 'noop.cjs'))
  } else {
    _require = require
  }
}
function dep(name, depsRoot) {
  loadDeps(depsRoot)
  return _require(name)
}

const PLACEHOLDER_RE = /\{\{\s*([^}\s][^}]*?)\s*\}\}/g

function main() {
  const specPath = process.argv[2]
  if (!specPath) return fail('missing specPath argument')
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
  const templatePath = spec.templatePath
  if (!templatePath) return fail('spec.templatePath is required')
  if (!fs.existsSync(templatePath)) return fail(`template not found: ${templatePath}`)

  run(templatePath, spec.depsRoot)
    .then((result) => {
      process.stdout.write(JSON.stringify(Object.assign({ ok: true }, result)))
    })
    .catch((err) => fail(err && err.message ? err.message : String(err)))
}

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }))
  process.exit(1)
}

async function run(templatePath, depsRoot) {
  const mammoth = dep('mammoth', depsRoot)
  // 1) Use mammoth to get an HTML representation: headings become <h1>..<h6>,
  //    lists become <li>, body text stays <p>. This gives a clean outline.
  const htmlResult = await mammoth.convertToHtml({ path: templatePath })
  const html = htmlResult.value || ''

  // 2) Extract placeholders from the raw document markup too (mammoth HTML is
  //    enough for the common case; plain text catches any leftovers).
  const extracted = await mammoth.extractRawText({ path: templatePath })
  const rawText = (extracted.value || '') + ' ' + stripTags(html)
  const placeholderNames = []
  const seen = new Set()
  let m
  PLACEHOLDER_RE.lastIndex = 0
  while ((m = PLACEHOLDER_RE.exec(rawText)) !== null) {
    const name = m[1].trim()
    if (!seen.has(name)) {
      seen.add(name)
      placeholderNames.push(name)
    }
  }

  // 3) Outline: walk the HTML block-level tags in document order.
  const outline = []
  const blockRe = /<(h[1-6]|p|li|table|ul|ol)\b[^>]*>|<\/(h[1-6]|p|li|table|ul|ol)>/gi
  let currentHeading = null
  const stack = []
  let guard = 0
  // Simple sequential scan capturing each heading's following text tag.
  const tagMatches = []
  let mm
  while ((mm = blockRe.exec(html)) !== null && guard++ < 200000) {
    tagMatches.push({ tag: (mm[1] || mm[2]).toLowerCase(), isOpen: !!mm[1], index: mm.index })
  }
  for (let i = 0; i < tagMatches.length; i++) {
    const t = tagMatches[i]
    if (!t.isOpen) continue
    const tag = t.tag
    const innerStart = t.index + html.slice(t.index).indexOf('>') + 1
    const next = tagMatches[i + 1]
    const innerEnd = next ? next.index : html.length
    const text = textOf(html.slice(innerStart, innerEnd)).trim()
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1])
      const item = { level, text, type: 'heading', placeholder: placeholderNames.find((p) => textMatch(text, p)) || null }
      // Approximate hierarchy using a stack of active heading levels.
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      const parent = stack.length ? stack[stack.length - 1].id : null
      item.id = `h${outline.length + 1}`
      item.parent = parent
      outline.push(item)
      stack.push(item)
    } else if (tag === 'li' || tag === 'p' || tag === 'table') {
      const kind = tag === 'li' ? 'list-item' : tag === 'table' ? 'table' : 'paragraph'
      const text = textOf(html.slice(innerStart, innerEnd)).trim()
      if (text) {
        outline.push({
          id: `p${outline.length + 1}`,
          type: kind,
          text: text.length > 300 ? text.slice(0, 300) : text,
          placeholder: placeholderNames.find((p) => textMatch(text, p)) || null,
          parent: stack.length ? stack[stack.length - 1].id : null,
        })
      }
    }
  }

  // 4) Style rules from word/styles.xml + word/document.xml defaults.
  const styles = await readTemplateStyles(templatePath, depsRoot)

  return {
    templatePath,
    placeholders: placeholderNames,
    outline,
    styles,
    paragraphCount: outline.filter((o) => o.type === 'paragraph' || o.type === 'list-item').length,
    headingCount: outline.filter((o) => o.type === 'heading').length,
  }
}

/** Strip inline tags and decode a handful of common entities. */
function textOf(html) {
  return stripTags(html)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, ' ')
}

/** Whether a heading/paragraph text mentions the placeholder variable name. */
function textMatch(text, placeholder) {
  const p = placeholder.toLowerCase()
  return text.toLowerCase().includes('{{' + p + '}}') || text.toLowerCase().includes(p)
}

/** Read the template's style defaults (font name + size) from its zip parts. */
async function readTemplateStyles(templatePath, depsRoot) {
  const JSZip = dep('jszip', depsRoot)
  const data = fs.readFileSync(templatePath)
  let zip
  try {
    zip = await JSZip.loadAsync(data)
  } catch (e) {
    return { source: 'template-unreadable', error: String(e && e.message) }
  }
  const stylesXml = zip.file('word/styles.xml')
  const bodyXml = zip.file('word/document.xml')
  let xml = ''
  if (stylesXml) xml = await stylesXml.async('string')
  if (bodyXml) {
    const body = await bodyXml.async('string')
    // The docDefaults inside styles.xml or the first paragraph properties usually
    // carry the document default font and size.
    if (!xml) xml = body
  }

  const fontMatch = xml.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/i)
  const sizeMatch = xml.match(/<w:sz\s+w:val="([0-9]+)"/i)
  return {
    source: 'styles.xml',
    defaultFont: fontMatch ? fontMatch[1] : undefined,
    defaultFontSizePt: sizeMatch ? Number(sizeMatch[1]) / 2 : undefined,
  }
}

main()
