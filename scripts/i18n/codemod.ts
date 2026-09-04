/**
 * i18n 存量技术债 —— 安全自动改写 codemod（默认只读预览，--apply 审核落地）
 *
 * 对 legacy 白名单（或指定文件）的中文硬编码违规，生成"可安全自动改写"的建议：
 *  - literal：整段字符串字面量且非数据值/日志/已有 t() 包裹，且文件已有 `t` 作用域
 *    → 改写为 t('key')，并把 key → 文案 写入 zh-CN.suggest.json 补丁
 *  - 不安全（JSX 文本需手工处理、主进程无 t 作用域、数据值/日志）→ 标记为需人工 TODO
 *
 * 安全策略（避免生成非法代码）：
 *  - 仅替换"整段表达式字符串字面量"，不触碰拼接/模板/插值。
 *  - 仅对"已存在 t 作用域"的文件落地（src/renderer 多数已用 useTranslation）；
 *    主进程（src/main）无 t，统一留人工（需走 IPC / 原生对话框路径）。
 *  - JSX 文本节点改写需 AST，本工具不自动落地，仅提示人工。
 *  - 复用 zh-CN.json 既有 key（去重）。
 *
 * 用法：
 *   npx tsx scripts/i18n/codemod.ts                      # dry-run 预览
 *   npx tsx scripts/i18n/codemod.ts --apply              # 落地安全改写 + 写补丁
 *   npx tsx scripts/i18n/codemod.ts --apply --out generated
 *
 * 铁律：dry-run 绝不写文件；--apply 只精确替换安全文本，不调用 del/批删。
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import type { Linter } from 'eslint'
import { lintI18nMessages, loadWhitelistFiles, loadZhCNValueIndex, ROOT } from './_shared'

interface Suggestion {
  file: string
  line: number
  col: number
  endLine: number
  endCol: number
  kind: 'jsx' | 'literal' | 'console'
  text: string
  proposedKey: string
  reuse: boolean
  safe: boolean
  reason: string
}

interface Edit {
  start: number
  end: number
  replacement: string
}

const DATA_KEY_RE =
  /\b(id|key|code|pattern|folderPattern|type|category|name|tag|slug|enumValue|errorCode|locale|ext|dir|folder)\s*[:=]/
const PATH_RE =
  /(?:^|[\s(=:'"])(?:\.{0,2}\/|[A-Za-z]:\\)|(?:^|[\s(=:'"])[^\s]+\.(?:ts|tsx|js|json|png|jpg|jpeg|svg|ico|exe|dll|so|wav|mp3|mp4)\b/i
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{2,}(?:\.[A-Z0-9_]+)+$/
const CONSOLE_RE = /console\s*\./
const HAS_T_RE = /useTranslation|from ['"]react-i18next['"]|[^.\w]t\(/

function locToIndex(content: string, line: number, column: number): number {
  const lines = content.split('\n')
  let idx = 0
  for (let i = 0; i < line - 1 && i < lines.length; i++) idx += lines[i].length + 1
  return idx + (column - 1)
}

function pathBasedPrefix(file: string): string {
  const parts = file.replace(/\.(ts|tsx)$/, '').split('/')
  if (parts[0] === 'src') parts.shift()
  const last = parts[parts.length - 1] ?? 'file'
  const base = last.replace(/\.(ts|tsx)$/, '')
  const rest = parts.slice(0, -1)
  return [...rest, base].join('.')
}

function contextLeaf(lineText: string, col1: number): string | null {
  const before = lineText.slice(0, col1)
  const m = before.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]\s*$/)
  if (!m) return null
  const raw = m[1]
  const camel = raw.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  return camel.replace(/[^a-z0-9-]/g, '') || null
}

function stripQuotes(s: string): string {
  const t = s.trim()
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith('`') && t.endsWith('`'))
  ) {
    return t.slice(1, -1)
  }
  return t
}

function fileHasTScope(content: string): boolean {
  return HAS_T_RE.test(content)
}

function setNested(obj: Record<string, unknown>, dotted: string, value: string): void {
  const parts = dotted.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

function applyEdits(content: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start)
  let out = content
  for (const e of sorted) out = out.slice(0, e.start) + e.replacement + out.slice(e.end)
  return out
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const outIdx = args.indexOf('--out')
  const outDir = outIdx !== -1 ? args[outIdx + 1] : undefined
  const targets = args.filter((a) => !a.startsWith('--') && a !== outDir)

  const whitelist = targets.length > 0 ? targets : await loadWhitelistFiles()
  if (whitelist.length === 0) {
    console.error('[i18n:codemod] 未找到目标文件（白名单为空且未指定参数）。')
    process.exit(1)
  }

  const valueIndex = loadZhCNValueIndex()
  const msgMap = await lintI18nMessages(whitelist)

  const suggestions: Suggestion[] = []
  const usedKeys = new Set<string>()
  const patch: Record<string, unknown> = {}
  let seq = 0

  for (const [file, msgs] of msgMap) {
    const content = fs.readFileSync(path.resolve(ROOT, file), 'utf-8')
    const lines = content.split('\n')
    const hasT = fileHasTScope(content)

    for (const m of msgs as Linter.LintMessage[]) {
      if (m.line == null || m.endLine == null) continue
      const start = locToIndex(content, m.line, m.column ?? 1)
      const end = locToIndex(content, m.endLine, m.endColumn ?? m.column ?? 1)
      const raw = content.slice(start, end)
      const lineText = lines[m.line - 1] ?? ''
      const msg = m.message ?? ''
      const isConsole = /console/.test(msg) || CONSOLE_RE.test(raw)
      const isJsx = /JSX/.test(msg)
      const kind: Suggestion['kind'] = isConsole ? 'console' : isJsx ? 'jsx' : 'literal'
      const text = isConsole ? raw.trim() : stripQuotes(raw).replace(/\s+/g, ' ').trim()
      if (!text) continue

      const beforeLit = lineText.slice(0, m.column ?? 1)
      const isDataValue =
        DATA_KEY_RE.test(beforeLit) || PATH_RE.test(text) || ERROR_CODE_RE.test(text)
      const alreadyT = /(^|[^.\w])t\(\s*['"]/.test(beforeLit)
      const existingKey = valueIndex.get(text)

      let proposedKey = ''
      let reuse = false
      let safe = false
      let reason = ''

      if (existingKey) {
        proposedKey = existingKey
        reuse = true
        reason =
          kind === 'literal' && !isDataValue && !alreadyT && hasT
            ? `复用现有 key: ${existingKey}，可安全包裹 t()`
            : '复用现有 key（但当前上下文不安全，留人工）'
        safe = kind === 'literal' && !isDataValue && !alreadyT && hasT
      } else if (kind === 'console') {
        reason = 'console 调试噪声：不应翻译，留人工（改用 logger）'
      } else if (isDataValue) {
        reason = '疑似数据值 / 标识 / 路径 / 错误码：不应翻译，留人工（eslint-disable 豁免）'
      } else if (alreadyT) {
        reason = '已被 t() 包裹，跳过'
      } else if (kind === 'jsx') {
        reason = 'JSX 文本节点需 AST 改写，留人工'
      } else if (!hasT) {
        reason = '文件无 t 作用域（主进程需走 IPC / 原生对话框），留人工'
      } else {
        const prefix = pathBasedPrefix(file)
        const leaf = contextLeaf(lineText, m.column ?? 1) ?? `s${++seq}`
        proposedKey = `${prefix}.${leaf}`
        let i = 1
        while (usedKeys.has(proposedKey)) proposedKey = `${prefix}.${leaf}${++i}`
        usedKeys.add(proposedKey)
        safe = true
        reason = `可安全改写为 t('${proposedKey}')`
        setNested(patch, proposedKey, text)
      }

      suggestions.push({
        file,
        line: m.line,
        col: m.column ?? 0,
        endLine: m.endLine,
        endCol: m.endColumn ?? m.column ?? 0,
        kind,
        text,
        proposedKey,
        reuse,
        safe,
        reason
      })
    }
  }

  const safeOnes = suggestions.filter((s) => s.safe)
  console.log(
    `共 ${suggestions.length} 条违规；可安全自动改写 ${safeOnes.length} 条；需人工 ${suggestions.length - safeOnes.length} 条。`
  )
  for (const s of suggestions) {
    const tag = s.safe ? '✅' : '⚠️'
    const keyInfo = s.proposedKey ? ` → ${s.proposedKey}` : ''
    console.log(
      `  ${tag} ${s.file}:${s.line}:${s.col} [${s.kind}] ${JSON.stringify(s.text)}${keyInfo}`
    )
    console.log(`      ↳ ${s.reason}`)
  }

  if (apply) {
    const byFile = new Map<string, Edit[]>()
    for (const s of safeOnes) {
      const content = fs.readFileSync(path.resolve(ROOT, s.file), 'utf-8')
      const start = locToIndex(content, s.line, s.col)
      const end = locToIndex(content, s.endLine, s.endCol)
      const edits = byFile.get(s.file) ?? []
      edits.push({ start, end, replacement: `t('${s.proposedKey}')` })
      byFile.set(s.file, edits)
    }
    let appliedFiles = 0
    for (const [file, edits] of byFile) {
      const content = fs.readFileSync(path.resolve(ROOT, file), 'utf-8')
      const next = applyEdits(content, edits)
      if (next !== content) {
        fs.writeFileSync(path.resolve(ROOT, file), next, 'utf-8')
        appliedFiles += 1
      }
    }
    console.log(`[i18n:codemod] 已改写 ${appliedFiles} 个文件，共 ${safeOnes.length} 处 t() 包裹。`)
    if (outDir || Object.keys(patch).length) {
      const dir = outDir ?? 'generated'
      fs.mkdirSync(path.resolve(process.cwd(), dir), { recursive: true })
      const patchPath = path.resolve(process.cwd(), dir, 'zh-CN.suggest.json')
      fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2), 'utf-8')
      console.log(`[i18n:codemod] locale 补丁 → ${patchPath}（${countKeys(patch)} 个新 key）`)
      console.log(
        '[i18n:codemod] 落地后请运行：npm run sync-i18n-keys && npm run i18n:check && npm run i18n:status'
      )
    }
  } else {
    console.log(
      '\n[i18n:codemod] 以上为 dry-run 预览。追加 --apply 可落地安全改写（人工项需手工处理）。'
    )
  }
}

function countKeys(obj: unknown): number {
  let n = 0
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const v of Object.values(obj as Record<string, unknown>)) n += countKeys(v)
  } else if (typeof obj === 'string') {
    n += 1
  }
  return n
}

// 供单测使用的纯函数（不影响 CLI 行为）
export { applyEdits, fileHasTScope }

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
