# dsh-doc-generator

> A DeepSeek Harness **agent preset** that generates compliant documents from a
> Word (`.docx`) template by asking an LLM to write the content, then rendering a
> new `.docx` that inherits the template's styling.
>
> 中文说明见 [README.zh-CN.md](./README.zh-CN.md).

---

## What it does

Given a Word template such as `template.docx`, this preset equips the agent with
three tools that run end to end:

| Tool | Signature | Purpose |
| --- | --- | --- |
| `parseTemplate` | `parseTemplate(templatePath)` | Parse a `.docx`: extract placeholders (`{{title}}`, `{{author}}`, …), the outline (heading hierarchy, paragraphs, lists), and inherited style rules (default font/size). |
| `draftDocument` | `draftDocument(requirements, contentPoints, writingStyle?)` | Ask the configured DeepSeek model to produce complete, spec-compliant Markdown for the given structure and content points. |
| `exportWord` | `exportWord(content, templatePath?, outputPath?)` | Render the Markdown into a standard `.docx` that inherits the template styling. |

A typical flow:

```
parseTemplate(template.docx) ─► { placeholders, outline, styles }
        │
draftDocument(requirements, "本周重点是原型设计与用户测试") ─► Markdown
        │
exportWord(markdown, template.docx) ─► weekly_report.docx
```

## Why this architecture

A DeepSeek Harness Host plugin cannot `require` third-party packages from its own
module scope, so all OOXML reading/writing is delegated to two **Node helper
scripts** shipped with the preset under `dscg-lib/`:

- `dscg-lib/parse-template.js` — reads the template and prints structured JSON.
- `dscg-lib/generate-docx.js` — renders Markdown to `.docx`.

The plugin shells out to `node` through the harness `shell` service and uses `fs`
to write scratch JSON spec files. `draftDocument` reuses the harness `llm` stream
API to call the active DeepSeek model.

Because the plugin only registers tools into the host `tools` registry and exposes
no service, its composition row sits loose in the preset (like `tool-fs` /
`tool-web`) and **does not need an `isolate` realm**.

> **Requirements for a regular Cordis plugin loaded by the Loader** (these were
> the exact source of mount failures on first authoring):
> 1. `export const inject = ['tools']` — declared before `ctx.tools` is used, or
>    the Guard rejects with `cannot get property "tools" without inject`.
> 2. every `ctx.tools.register(...)` tool must declare `output: { schema, render }`.
> 3. use the namespace export shape (`name` / `inject` / `apply`, **no default
>    export**) — a default would make `Loader.unwrapExports` drop `inject`.

## Repository layout

This repository **is** the preset directory: copy it into your agent-presets root
to deploy. The composition and the plugin resolve **relative to this directory**.

```
dsh-doc-generator/
├─ agent.cordis.yml     # agent-preset composition (based on the standard preset),
│                       #   with the dsh-doc-generator row mounted at ./index.mjs
├─ preset.yml           # display metadata (name / description)
├─ index.mjs            # plugin (ESM, namespace exports: name / inject / apply)
├─ dscg-lib/
│  ├─ parse-template.js # template → { placeholders, outline, styles }
│  └─ generate-docx.js  # markdown → .docx
├─ package.json         # deps: docx, mammoth
└─ LICENSE              # MIT
```

## Installation

```bash
npm install        # installs docx + mammoth
```

After `npm install`, the plugin's `depsRoot` defaults to this repository root, so
no extra configuration is needed.

### Deploy as a DeepSeek Harness agent preset — quick clone guide

The repository root **is** the preset directory, so deploying is a clone (or copy)
into your Harness user-preset root plus an `npm install`.

#### Prerequisites

- A DeepSeek Harness deployment running with agent presets enabled (the
  `agent-presets` roster mounts presets from `${DSH_HOME}/.agent-presets`, where
  `DSH_HOME` defaults to `${HOME}/.dsh`).
- [Node.js](https://nodejs.org) ≥ 18 and `npm` on `PATH` (to install `docx` +
  `mammoth`).
- `git` (only if you want the clone/keep-in-sync workflow).

#### Step 1 — clone

```bash
git clone https://github.com/chenjiajungithub/dsh-doc-generator.git
cd dsh-doc-generator        # branch `master` is checked out
```

#### Step 2 — install dependencies

```bash
npm install
```

`docx` and `mammoth` are the only runtime dependencies. After this, the plugin's
`depsRoot` defaults to the checked-out directory, so no extra config is needed.

#### Step 3 — place it under the agent-presets root

```bash
# Assuming DSH_HOME=${HOME}/.dsh — adjust to your real DSH_HOME if set.
cp -R dsh-doc-generator "${DSH_HOME}/.agent-presets/dsh-doc-generator"
```

> Alternative without `git`: just clone straight into a fresh directory under the
> preset root and run `npm install` there:
>
> ```bash
> mkdir -p "${DSH_HOME}/.agent-presets"
> git clone https://github.com/chenjiajungithub/dsh-doc-generator.git \
>   "${DSH_HOME}/.agent-presets/dsh-doc-generator"
> cd "${DSH_HOME}/.agent-presets/dsh-doc-generator" && npm install
> ```

#### Step 4 — start a session on the preset

In the Web UI, open the preset picker and choose **文档生成助手** (Document
Generator), then create a new session. The session tool list should include
`parseTemplate`, `draftDocument`, and `exportWord`.

Sanity check on an empty box:

```bash
node --check index.mjs                       # plugin module is valid ESM
node --check dscg-lib/parse-template.js      # helper is valid CommonJS
node --check dscg-lib/generate-docx.js
```

#### Updating after a release

```bash
cd "${DSH_HOME}/.agent-presets/dsh-doc-generator"
git pull          # bring in the latest master
npm install       # refresh deps if the lockfile changed
```

> **Important — restart after an update.** The Harness Loader imports
> relative-path plugins through the **Node ESM module cache keyed by file URL**.
> If you edit `index.mjs` (or `git pull` a newer one) while the host is running,
> **restart the Harness** so the corrected module is imported afresh.

#### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `cannot get property "tools" without inject` | Stale cached module from before a fix — restart the Harness process. |
| `tool ... must declare output { schema, render, presentationMeta? }` | Not a runtime config issue; the shipped plugin already declares `output` — make sure you are on the latest `master` and restarted. |
| Model says `no provider/model selection available` | No DeepSeek provider/model is configured on the session's route; configure one in settings. |
| `exportWord` fails to produce a file | Confirm the template path is a real `.docx` and that a writable output path is given (or that `<preset>/out` is writable). |

## Configuration

The preset row accepts optional `config` (all default sensibly):

| field | default | meaning |
| --- | --- | --- |
| `defaultOutputDir` | `<repo>/out` | Where `exportWord` writes when `outputPath` is omitted. |
| `depsRoot` | `<repo>` | Directory that *contains* `node_modules` (the helper scripts resolve `docx`/`mammoth`/`jszip` from here). |
| `helperDir` | `<repo>/dscg-lib` | Where the helper scripts live. |

## Usage example

Tell the agent:

> Please use `E:\...\template.docx` as the template to write a "Project Weekly
> Report"; this week's focus is prototype design and user testing.

The agent will call `parseTemplate` → `draftDocument` → `exportWord` and reply with
something like `文档已生成，保存路径为 .../weekly_report.docx`.

## License

[MIT](./LICENSE) © 2026 Chen JiaJun.
