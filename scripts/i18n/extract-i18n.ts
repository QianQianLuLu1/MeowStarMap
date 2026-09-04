/**
 * i18n 存量技术债 —— 提取建议脚本（只读 / 建议型，增强版）
 *
 * 针对 legacy 白名单（或指定文件）中的中文硬编码违规，逐条产出可执行的修复建议：
 *  - 命中 zh-CN.json 已有相同中文值 → 直接复用既有 key（去重，不再新建）
 *  - console 调试噪声 → 建议改用 logger / 豁免，不应翻译
 *  - 数据值 / DB 标识 / 文件路径 / 错误码形态 → 建议 eslint-disable 整行豁免，不应翻译
 *  - 其余纯 UI 文案 → 建议包裹 t('key')，并生成语义化 key 草稿与 locale 补丁
 *
 * 增强点（相对初版）：
 *  - 复用 _shared.loadZhCNValueIndex 去重，避免重复建 key
 *  - 强化数据值 / 日志识别（对象属性键 id/key/code/pattern…，文件路径、错误码形态）
 *  - 输出新增：按 kind / 模块汇总表 + 豁免候选（数据值 / 日志）清单
 *  - --out 落盘的 zh-CN.suggest.json 自动排除已存在 key 与数据值 / 日志
 *
 * 用法：
 *   npx tsx scripts/i18n/extract-i18n.ts
 *   npx tsx scripts/i18n/extract-i18n.ts src/renderer/components/common/UpdateDialog.tsx
 *   npx tsx scripts/i18n/extract-i18n.ts --out generated
 *
 * 铁律：本脚本只读，绝不 writeFile 改源码；--out 仅写独立的建议 / 补丁文档。
 */

import * as fs from 'fs'
import * as path from 'path'
import type { Linter } from 'eslint'
import { lintI18nMessages, loadWhitelistFiles, loadZhCNValueIndex, ROOT } from './_shared'

interface Suggestion {
  file: string
  line: number
  col: number
  kind: 'jsx' | 'literal' | 'console'
  text: string
  proposedKey: string
  note: string
  reusable: boolean
}

// 行内左侧出现这些属性键（含中文值）→ 判定为数据值 / DB 标识，不应翻译
const DATA_KEY_RE =
  /\b(id|key|code|pattern|folderPattern|type|category|name|tag|slug|enumValue|errorCode|locale|ext|dir|folder)\s*[:=]/
// 文件路径形态：目录分隔符或常见扩展名
const PATH_RE =
  /(?:^|[\s(=:'"])(?:\.{0,2}\/|[A-Za-z]:\\)|(?:^|[\s(=:'"])[^\s]+\.(?:ts|tsx|js|json|png|jpg|jpeg|svg|ico|exe|dll|so|wav|mp3|mp4)\b/i
// 错误码形态：全大写 + 点/下划线（如 NET.TIMEOUT / DB_CONN_ERR）
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{2,}(?:\.[A-Z0-9_]+)+$/
const CONSOLE_RE = /console\s*\./

function moduleOf(file: string): string {
  const parts = file.split('/')
  if (parts[0] === 'src' && parts[1]) return `${parts[0]}/${parts[1]}`
  return parts[0] ?? 'unknown'
}

function locToIndex(content: string, line: number, column: number): number {
  const lines = content.split('\n')
  let idx = 0
  for (let i = 0; i < line - 1 && i < lines.length; i++) idx += lines[i].length + 1
  return idx + (column - 1)
}

// 路径 → 语义化前缀（去掉 src/renderer|main|shared 前缀，末级文件名做短名）
function pathBasedPrefix(file: string): string {
  const parts = file.replace(/\.(ts|tsx)$/, '').split('/')
  if (parts[0] === 'src') parts.shift()
  const last = parts[parts.length - 1] ?? 'file'
  const base = last.replace(/\.(ts|tsx)$/, '')
  const rest = parts.slice(0, -1)
  return [...rest, base].join('.')
}

// 取中文文本所在行的左邻标识符作为 key 叶名（去符号），失败回退序号由调用方处理
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

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const outIdx = args.indexOf('--out')
  const outDir = outIdx !== -1 ? args[outIdx + 1] : undefined
  const targets = args.filter((a) => !a.startsWith('--') && a !== outDir)

  const whitelist = targets.length > 0 ? targets : await loadWhitelistFiles()
  if (whitelist.length === 0) {
    console.error('[i18n:extract] 未找到目标文件（白名单为空且未指定参数）。')
    process.exit(1)
  }

  const valueIndex = loadZhCNValueIndex()
  const msgMap = await lintI18nMessages(whitelist)

  const suggestions: Suggestion[] = []
  const usedKeys = new Set<string>()
  const patch: Record<string, unknown> = {}
  const byKind: Record<string, number> = { jsx: 0, literal: 0, console: 0 }
  const byModule: Record<string, number> = {}
  const dataValueCandidates: Suggestion[] = []
  const reusableCount = { n: 0 }
  let seq = 0

  for (const [file, msgs] of msgMap) {
    const content = fs.readFileSync(path.resolve(ROOT, file), 'utf-8')
    const lines = content.split('\n')
    const moduleKey = moduleOf(file)
    byModule[moduleKey] = (byModule[moduleKey] ?? 0) + msgs.length

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
      byKind[kind] = (byKind[kind] ?? 0) + 1

      const text = isConsole ? raw.trim() : stripQuotes(raw).replace(/\s+/g, ' ').trim()
      if (!text) continue

      const before = lineText.slice(0, m.column ?? 1)
      const isDataValue = DATA_KEY_RE.test(before) || PATH_RE.test(text) || ERROR_CODE_RE.test(text)
      const existingKey = valueIndex.get(text)

      let proposedKey = ''
      let note = ''
      let reusable = false

      if (existingKey) {
        proposedKey = existingKey
        note = `复用现有 key: ${existingKey}（zh-CN.json 已有相同值）`
        reusable = true
        reusableCount.n += 1
      } else if (kind === 'console') {
        note = 'console 调试噪声：建议改用项目统一 logger，或保留在豁免文件，不应翻译'
      } else if (isDataValue) {
        note =
          '疑似数据值 / DB 标识 / 文件路径 / 错误码：通常不应翻译，建议 eslint-disable 整行豁免'
        dataValueCandidates.push({
          file,
          line: m.line,
          col: m.column ?? 0,
          kind,
          text,
          proposedKey: '',
          note,
          reusable: false
        })
      } else {
        const prefix = pathBasedPrefix(file)
        const leaf = contextLeaf(lineText, m.column ?? 1) ?? `s${++seq}`
        proposedKey = `${prefix}.${leaf}`
        let i = 1
        while (usedKeys.has(proposedKey)) proposedKey = `${prefix}.${leaf}${++i}`
        usedKeys.add(proposedKey)
        note = `建议包裹为 t('${proposedKey}', '${text}')；命名请按 docs/i18n/fix-sop.md 复核`
        setNested(patch, proposedKey, text)
      }

      suggestions.push({
        file,
        line: m.line,
        col: m.column ?? 0,
        kind,
        text,
        proposedKey,
        note,
        reusable
      })
    }
  }

  if (outDir) {
    fs.mkdirSync(path.resolve(process.cwd(), outDir), { recursive: true })
    const patchPath = path.resolve(process.cwd(), outDir, 'zh-CN.suggest.json')
    fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2), 'utf-8')
    const dvPath = path.resolve(process.cwd(), outDir, 'data-value-candidates.json')
    fs.writeFileSync(
      dvPath,
      JSON.stringify(
        dataValueCandidates.map((d) => ({ file: d.file, line: d.line, text: d.text })),
        null,
        2
      ),
      'utf-8'
    )
    console.log(
      `[i18n:extract] 补丁草稿 → ${patchPath}（${Object.keys(flattenKeys(patch)).length} 个新 key）`
    )
    console.log(`[i18n:extract] 豁免候选 → ${dvPath}（${dataValueCandidates.length} 条）`)
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        { suggestions, patch, summary: { byKind, byModule, reusable: reusableCount.n } },
        null,
        2
      )
    )
    return
  }

  console.log(
    `共 ${suggestions.length} 条建议（复用现有 key ${reusableCount.n} 条，待新建 ${Object.keys(flattenKeys(patch)).length} 条）`
  )
  console.log('按类型：', byKind)
  console.log('按模块：', byModule)
  console.log('')
  for (const s of suggestions) {
    const keyInfo = s.proposedKey ? ` → ${s.proposedKey}` : ''
    console.log(`  ${s.file}:${s.line}:${s.col} [${s.kind}] ${JSON.stringify(s.text)}${keyInfo}`)
    console.log(`      ↳ ${s.note}`)
  }
  if (dataValueCandidates.length) {
    console.log('')
    console.log(`豁免候选（数据值 / 日志，共 ${dataValueCandidates.length} 条）：`)
    for (const d of dataValueCandidates)
      console.log(`  ${d.file}:${d.line}: ${JSON.stringify(d.text)}`)
  }
}

function flattenKeys(obj: unknown, prefix = ''): string[] {
  const out: string[] = []
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const full = prefix ? `${prefix}.${k}` : k
      out.push(full)
      out.push(...flattenKeys(v, full))
    }
  }
  return out
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
