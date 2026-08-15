# dsh-doc-generator

> 一个 DeepSeek Harness **agent preset**：根据 Word (.docx) 模板，调用大模型撰写
> 内容，并输出继承模板样式的标准 .docx 文档。
>
> English version: [README.md](./README.md)

---

## 功能

给定一个 Word 模板（如 `template.docx`），该 preset 为 Agent 提供三个工具，端到端
完成「解析模板 → AI 撰写 → 导出 Word」：

| 工具 | 签名 | 作用 |
| --- | --- | --- |
| `parseTemplate` | `parseTemplate(templatePath)` | 解析一个 .docx：提取占位符（`{{title}}`、`{{author}}`…）、大纲结构（标题层级/段落/列表）以及继承的样式规则（默认字体/字号）。 |
| `draftDocument` | `draftDocument(requirements, contentPoints, writingStyle?)` | 调用当前配置的 DeepSeek 模型，按“结构要求 + 内容要点”生成完整、符合规范的 Markdown。 |
| `exportWord` | `exportWord(content, templatePath?, outputPath?)` | 将 Markdown 应用模板样式渲染成新的标准 .docx。 |

典型流程：

```
parseTemplate(template.docx) ─► { placeholders, outline, styles }
        │
draftDocument(requirements, "本周重点是原型设计与用户测试") ─► Markdown
        │
exportWord(markdown, template.docx) ─► weekly_report.docx
```

## 为什么这样实现

DeepSeek Harness 的插件代码无法在自己的模块作用域内 `require` 第三方包，因此所有
OOXML 读写都被委托给随 preset 分发的两个 **Node 辅助脚本**（位于 `dscg-lib/`）：

- `dscg-lib/parse-template.js` — 读取模板并输出结构化 JSON。
- `dscg-lib/generate-docx.js` — 把 Markdown 渲染为 .docx。

插件通过 harness 的 `shell` 服务调用 `node`，用 `fs` 服务写入临时 JSON 规格文件；
`draftDocument` 复用 harness 的 `llm` 流式接口调用 DeepSeek 模型。

因为插件只向 host `tools` 注册工具、不发布任何服务，其挂载行在 preset 里作为**松散
行**存在（同 `tool-fs` / `tool-web`），**不需要** `isolate` realm。

> **常规 Cordis 插件（经 Loader 挂载）的必需项**（正是最初挂载失败的原因）：
> 1. `export const inject = ['tools']` —— 使用 `ctx.tools` 前必须声明，否则 Guard
>    报 `cannot get property "tools" without inject`；
> 2. 每个 `ctx.tools.register(...)` 的工具都必须提供 `output: { schema, render }`；
> 3. 采用 namespace 导出形态（`name` / `inject` / `apply`，**不要 default 导出**
>    —— default 会被 `Loader.unwrapExports` 丢弃，从而丢掉 `inject`）。

## 仓库结构

本仓库**就是**该 preset 目录：把整个仓库拷到你的 agent-presets 根目录即可部署。
composition 与插件都**相对本目录**解析。

```
dsh-doc-generator/
├─ agent.cordis.yml     # agent-preset 组成（基于标准 preset），
│                       #   末尾挂载 dsh-doc-generator 行（./index.mjs）
├─ preset.yml           # 显示元数据（name/description）
├─ index.mjs            # 插件（ESM，namespace 导出：name / inject / apply）
├─ dscg-lib/
│  ├─ parse-template.js # 模板 → { placeholders, outline, styles }
│  └─ generate-docx.js  # markdown → .docx
├─ package.json         # 依赖：docx、mammoth
└─ LICENSE              # MIT
```

## 安装

```bash
npm install        # 安装 docx + mammoth
```

`npm install` 之后，插件的 `depsRoot` 默认指向仓库根目录，无需额外配置。

### 作为 DeepSeek Harness agent preset 部署 —— 直接 git clone 指引

本仓库根目录**就是**该 preset 目录，所以部署 = 把仓库 clone（或拷贝）到 Harness 的
用户 preset 根目录，再 `npm install`。

#### 前置条件

- 一个已启用 agent preset 的 DeepSeek Harness 部署（`agent-presets` 目录从
  `${DSH_HOME}/.agent-presets` 读取 preset，`DSH_HOME` 缺省为 `${HOME}/.dsh`）。
- [Node.js](https://nodejs.org) ≥ 18 与 `npm`（用于安装 `docx` + `mammoth`）。
- `git`（仅当你想要 clone / 保持同步的工作流时需要）。

#### 第 1 步 —— clone

```bash
git clone https://github.com/chenjiajungithub/dsh-doc-generator.git
cd dsh-doc-generator        # 默认检出 master 分支
```

#### 第 2 步 —— 安装依赖

```bash
npm install
```

唯一运行时依赖是 `docx` 与 `mammoth`。安装后插件的 `depsRoot` 默认指向检出目录，
无需额外配置。

#### 第 3 步 —— 放到 agent-presets 根目录

```bash
# 假设 DSH_HOME=${HOME}/.dsh —— 若你设了其他 DSH_HOME 请相应调整。
cp -R dsh-doc-generator "${DSH_HOME}/.agent-presets/dsh-doc-generator"
```

> 不含 git 的替代方式：直接 clone 到 preset 根下的新目录并安装依赖：
>
> ```bash
> mkdir -p "${DSH_HOME}/.agent-presets"
> git clone https://github.com/chenjiajungithub/dsh-doc-generator.git \
>   "${DSH_HOME}/.agent-presets/dsh-doc-generator"
> cd "${DSH_HOME}/.agent-presets/dsh-doc-generator" && npm install
> ```

#### 第 4 步 —— 在该 preset 上新建会话

在 Web UI 打开 preset 选择器，选择 **文档生成助手**（Document Generator），然后
新建一个会话。会话工具列表应包含 `parseTemplate`、`draftDocument`、`exportWord`。

在已知目录做快速自检：

```bash
node --check index.mjs                       # 插件模块是合法 ESM
node --check dscg-lib/parse-template.js      # 辅助脚本是合法 CommonJS
node --check dscg-lib/generate-docx.js
```

#### 发布后更新

```bash
cd "${DSH_HOME}/.agent-presets/dsh-doc-generator"
git pull          # 拉取最新 master
npm install       # 若 lockfile 有变化则刷新依赖
```

> **重要 —— 更新后重启。** Harness Loader 对相对路径插件走 **Node ESM import，
> 并按文件 URL 缓存**导入结果。若在宿主运行期间修改 `index.mjs`（或 `git pull`
> 到新版本），请**重启 Harness**，否则会加载到旧模块。

#### 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `cannot get property "tools" without inject` | 修复前缓存的旧模块 —— 重启 Harness 进程。 |
| `tool ... must declare output { schema, render, presentationMeta? }` | 并非运行时配置问题；已发布的插件自带 `output` —— 确保在最新 `master` 并已重启。 |
| 模型提示 `no provider/model selection available` | 会话路由上未配置 DeepSeek provider/model —— 在设置中配置。 |
| `exportWord` 未产出文件 | 确认模板路径是真实 `.docx`，且 output 路径可写（或 `<preset>/out` 可写）。 |

## 配置

挂载行可选 `config`（默认均合理）：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `defaultOutputDir` | `<repo>/out` | `outputPath` 缺省时 `exportWord` 的输出目录。 |
| `depsRoot` | `<repo>` | 目录（**其下含 node_modules**）；辅助脚本从这里解析 `docx`/`mammoth`/`jszip`。 |
| `helperDir` | `<repo>/dscg-lib` | 辅助脚本所在目录。 |

## 使用示例

对 Agent 说：

> 请根据 `E:\...\template.docx` 这个模板，写一份关于「项目周报」的文档，本周重点
> 是完成原型设计和用户测试。

Agent 会依次调用 `parseTemplate` → `draftDocument` → `exportWord`，最后返回类似
`文档已生成，保存路径为 .../weekly_report.docx`。

## 许可

[MIT](./LICENSE) © 2026 Chen JiaJun。
