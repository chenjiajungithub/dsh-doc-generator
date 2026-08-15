// dsh-doc-generator — 可随 agent preset 部署的标准 Cordis 插件（ESM）。
//
// 本文件是 preset 自带的本地插件，被 agent.cordis.yml 以相对路径挂载：
//     - id: dsh-doc-generator
//       name: ./index.mjs
//
// 背景：
//   - 插件在 Host 进程内无法 `require` 第三方包，因此 OOXML 读写被委托给与
//     本文件同级的 dscg-lib/ 下两个 Node 脚本，插件经 `shell`/`fs` 服务调用。
//   - 依赖 docx / mammoth / jszip 由 config.depsRoot（一个含 node_modules 的目录）
//     提供；缺省 = 本文件所在目录（即仓库根，先 `npm install` 即可）。
//   - 相对路径 + 自解析 helperDir 使本 preset 目录可整体拷贝、随 preset 部署。
//
// config（来自 agent.cordis.yml 该行，均可选）：
//   defaultOutputDir: 未显式指定 outputPath 时的默认输出目录（缺省 <dir>/out）
//   depsRoot:         含 node_modules 的目录（docx/mammoth/jszip），缺省 = <dir>
//   helperDir:        覆盖 dscg-lib 目录（缺省 <dir>/dscg-lib）

import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-doc-generator'

// Declare the hard dependency: `ctx.tools` is only legal after `inject` lists
// it. A preset row is loaded by the Cordis Loader (not the dynamic
// `harness.registerTool` path), so the Guard requires the declaration. This is
// the namespace-plugin export shape used by every shipped `@deepseek-ai/dsh-*`
// plugin (name / inject / apply, NO default export — a default would make
// `Loader.unwrapExports` take it and drop inject).
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const fs = ctx.get('fs')
  const shell = ctx.get('shell')
  if (fs === undefined || shell === undefined) return

  const helperDir = config.helperDir || path.join(__dirname, 'dscg-lib')
  const defaultOutputDir = config.defaultOutputDir || path.join(__dirname, 'out')
  // Directory that CONTAINS node_modules (repo root by default after npm install).
  // The helper scripts resolve docx/mammoth/jszip from here via createRequire.
  const depsRoot = config.depsRoot || __dirname

  function stamp() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  }

  /** 运行一个辅助 Node 脚本；spec 写临时 JSON 文件，解析脚本 stdout 首行。 */
  async function runHelper(scriptName, spec, exec) {
    const specFile = path.join(helperDir, `.dscg-${stamp()}.json`)
    const target = await fs.resolve(specFile)
    await fs.writeText(target, JSON.stringify(spec), undefined, exec.signal)

    const request = {
      command: `node ${scriptName} ${JSON.stringify(specFile)}`,
      workdir: helperDir,
      timeoutMs: 90000,
      signal: exec.signal,
    }
    const resolved = shell.resolve(request)
    const result = await shell.run(resolved)
    const out = result.stdout.text || ''
    try {
      return JSON.parse(out.split('\n')[0])
    } catch {
      return { ok: false, error: `no JSON from ${scriptName}: ${out}` }
    }
  }

  // 通过 llm 服务调用当前配置的 DeepSeek 模型生成 Markdown。
  async function draftViaModel(requirements, contentPoints, writingStyle) {
    const llm = ctx.get('llm')
    const agentDefaultModel = ctx.get('agentDefaultModel')
    if (!llm) throw new Error('llm service unavailable — cannot draft content')

    let provider
    let model
    if (agentDefaultModel) {
      const sel = agentDefaultModel.currentSelection()
      if (sel) { provider = sel.provider; model = sel.model }
    }
    if (!provider || !model) throw new Error('no provider/model selection available for draftDocument')

    const structure = requirements && Array.isArray(requirements.outline)
      ? requirements.outline
          .filter((o) => o && (o.type === 'heading' || o.type === 'paragraph'))
          .map((o) => o.type + ': ' + (o.text || ''))
          .slice(0, 60)
          .join('\n')
      : '(未提供模板结构，请按你对该类型文档的规范自行组织结构)'

    const styleHint = writingStyle ? `请采用“${writingStyle}”的写作风格，` : '请采用正式规范的写作风格，'
    const prompt = [
      '你是一个规范的文档撰写助手。请遵循下面的“文档结构要求”，结合“内容要点”，',
      styleHint + '只输出一份完整的 Markdown 格式文档正文（不要输出前言说明或多余注释）。',
      '',
      '【文档结构要求】(来自模板解析):',
      structure,
      '',
      '【内容要点】:',
      String(contentPoints || ''),
    ].join('\n')

    const messages = [{
      id: 'dscg-msg-' + stamp(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dsh-doc-generator' },
    }]

    let markdown = ''
    for await (const chunk of llm.stream({ provider, model, messages, maxTokens: 4000 })) {
      if (chunk.type === 'text-delta') markdown += chunk.text
      else if (chunk.type === 'finish') break
    }
    if (!markdown.trim()) throw new Error('model returned no text content')
    return markdown
  }

  // 工具 A：解析模板。
  ctx.tools.register({
    name: 'parseTemplate',
    description: [
      '解析一个 Word (.docx) 模板文件，提取占位符（如 {{title}}、{{author}}）、',
      '文档大纲结构（标题层级、段落、列表）以及从模板继承的样式规则（默认字体与字号）。',
      '输入 templatePath（模板路径），返回结构化描述，可作为 draftDocument 的 requirements。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        templatePath: { type: 'string', description: 'Word 模板文件路径 (.docx)' },
      },
      required: ['templatePath'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      if (typeof args.templatePath !== 'string' || !args.templatePath) {
        return { ok: false, error: 'templatePath is required' }
      }
      const spec = { templatePath: args.templatePath }
      if (depsRoot) spec.depsRoot = depsRoot
      const result = await runHelper('parse-template.js', spec, exec)
      if (!result.ok) return { ok: false, error: result.error }
      return {
        ok: true,
        templatePath: args.templatePath,
        placeholders: result.placeholders,
        outline: result.outline,
        styles: result.styles,
        paragraphCount: result.paragraphCount,
        headingCount: result.headingCount,
      }
    },
  })

  // 工具 B：智能撰写。
  ctx.tools.register({
    name: 'draftDocument',
    description: [
      '根据 parseTemplate 解析出的“文档要求”（结构+样式）与用户写作要点，',
      '调用 DeepSeek 大模型生成符合规范、结构完整的 Markdown 格式文档内容。',
      '输入 requirements（parseTemplate 的结构化输出）、contentPoints（内容要点）与可选的 writingStyle（写作风格），返回完整 Markdown 文档。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        requirements: { type: 'object', additionalProperties: true, description: 'parseTemplate 输出的结构化文档要求' },
        contentPoints: { type: 'string', description: '用户提供的写作要点或主题' },
        writingStyle: { type: 'string', description: '可选写作风格，如“正式公文”“技术报告”“学术论文”' },
      },
      required: ['contentPoints'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const markdown = value && typeof value === 'object' ? value.markdown : value
        return [{ type: 'text', text: markdown || JSON.stringify(value) }]
      },
    },
    async execute(args) {
      try {
        const markdown = await draftViaModel(args.requirements || {}, args.contentPoints, args.writingStyle || '通用公文')
        return { ok: true, markdown, writingStyle: args.writingStyle || '通用公文' }
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) }
      }
    },
  })

  // 工具 C：导出 Word。
  ctx.tools.register({
    name: 'exportWord',
    description: [
      '将 draftDocument 生成的 Markdown 内容应用模板样式后导出为一份新的标准 .docx 文件。',
      '输入 content（Markdown 内容）、templatePath（继承样式的原始模板路径，可省略）与 outputPath（保存路径，可省略以使用默认输出目录）。',
      '返回成功或失败信息以及实际保存路径。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        content: { type: 'string', description: 'draftDocument 输出的 Markdown 文档内容' },
        templatePath: { type: 'string', description: '原始 Word 模板路径，用于继承样式（可省略）' },
        outputPath: { type: 'string', description: '新文档保存路径 (.docx)，可省略使用默认输出目录' },
      },
      required: ['content'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const content = args.content
      if (typeof content !== 'string' || !content.trim()) {
        return { ok: false, error: 'content (markdown) is required' }
      }
      const outputPath = typeof args.outputPath === 'string' && args.outputPath
        ? args.outputPath
        : path.join(defaultOutputDir, `document-${stamp()}.docx`)

      let defaultFont
      let defaultFontSizePt
      if (args.templatePath) {
        const tplSpec = { templatePath: args.templatePath }
        if (depsRoot) tplSpec.depsRoot = depsRoot
        const tpl = await runHelper('parse-template.js', tplSpec, exec)
        if (tpl.ok && tpl.styles) {
          defaultFont = tpl.styles.defaultFont
          defaultFontSizePt = tpl.styles.defaultFontSizePt
        }
      }
      const spec = {
        content,
        outputPath,
        ...(args.templatePath ? { templatePath: args.templatePath } : {}),
        defaultFont,
        defaultFontSizePt,
      }
      if (depsRoot) spec.depsRoot = depsRoot
      const result = await runHelper('generate-docx.js', spec, exec)
      if (!result.ok) return { ok: false, error: result.error }
      const saved = result.outputPath || outputPath
      return { ok: true, outputPath: saved, message: `文档已生成，保存路径为 ${saved}` }
    },
  })
}
