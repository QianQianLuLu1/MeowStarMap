/**
 * i18n 工具公共层（只读）
 *
 * 为 whitelist-status / extract-i18n / prune-whitelist / codemod / guard 提供统一数据源，
 * 消除各脚本重复实现 flat config 解析与 ESLint 调用：
 *  - loadWhitelistFiles()        : 解析 eslint.config.js 中 warn 级 no-restricted-syntax 白名单（单一真相源）
 *  - findWarnBlockSpan(text)     : 定位 warn 块 files 数组在文本中的起止，供解析与瘦身共用
 *  - lintI18nMessages(files)     : 复用项目真实 ESLint 配置，返回每文件的中文硬编码违规消息（含完整 range/message）
 *  - lintNoRestrictedSyntax(files): 返回每文件违规数与位置（供 status / prune / guard 统计）
 *  - loadZhCNValueIndex()        : 构建 zh-CN.json 的中文值 -> 既有 key 反查表（去重用）
 *
 * 白名单解析采用"文本静态解析"而非动态 import eslint.config.js：避免在不同运行环境
 * （tsx / vitest）下因 URL 编码（空格路径）加载失败，也更轻量。
 *
 * 铁律：本模块只读，绝不 writeFile 改源码 / eslint 配置。
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { ESLint } from 'eslint'
import type { Linter } from 'eslint'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '..', '..')
export const CONFIG_PATH = path.join(ROOT, 'eslint.config.js')
export const ZH_CN_PATH = path.join(ROOT, 'src', 'renderer', 'i18n', 'locales', 'zh-CN.json')

export interface FileLoc {
  line: number
  col: number
}

export interface FileStat {
  file: string
  violations: number
  loc: FileLoc[]
}

const CN_RE = /[一-龥]/

interface FlatEntry {
  key: string
  value: unknown
}

function flatten(obj: unknown, prefix = ''): FlatEntry[] {
  const out: FlatEntry[] = []
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const fullKey = prefix ? `${prefix}.${k}` : k
      out.push({ key: fullKey, value: v })
      out.push(...flatten(v, fullKey))
    }
  }
  return out
}

/** warn 块 files 数组在配置文本中的起止偏移（innerStart 指向 `[` 之后，filesEnd 指向 `]`）。 */
export interface WarnBlockSpan {
  innerStart: number
  filesEnd: number
}

export function findWarnBlockSpan(text: string): WarnBlockSpan | null {
  const warnMarker = "no-restricted-syntax': ['warn'"
  const wi = text.indexOf(warnMarker)
  if (wi === -1) return null
  const before = text.slice(0, wi)
  const filesStart = before.lastIndexOf('files: [')
  if (filesStart === -1) return null
  const afterFiles = text.slice(filesStart)
  const closeMatch = afterFiles.match(/\],\s*rules/s)
  if (!closeMatch || closeMatch.index == null) return null
  return {
    innerStart: filesStart + 'files: ['.length,
    filesEnd: filesStart + closeMatch.index
  }
}

/** 从 eslint.config.js 文本中解析 warn 级白名单文件清单。 */
export function parseWhitelistFiles(text: string): string[] {
  const span = findWarnBlockSpan(text)
  if (!span) return []
  const inner = text.slice(span.innerStart, span.filesEnd)
  const out: string[] = []
  for (const line of inner.split('\n')) {
    const t = line.trim()
    const mm = t.match(/^(['"])(.+?)\1,?$/)
    if (mm) out.push(mm[2])
  }
  return out
}

/**
 * 解析 flat config 中定位 no-restricted-syntax 为 ['warn', ...] 的块，取其 files 清单。
 * 文件从白名单移除后本函数自动跟进（单一真相源）。
 */
export async function loadWhitelistFiles(): Promise<string[]> {
  return parseWhitelistFiles(fs.readFileSync(CONFIG_PATH, 'utf-8'))
}

/** 构建 zh-CN.json 中"含中文的字符串值 -> 既有 key"反查表（首个命中为准）。 */
export function loadZhCNValueIndex(): Map<string, string> {
  const raw = fs.readFileSync(ZH_CN_PATH, 'utf-8')
  const json = JSON.parse(raw) as unknown
  const index = new Map<string, string>()
  for (const { key, value } of flatten(json)) {
    if (typeof value === 'string' && CN_RE.test(value) && !index.has(value)) {
      index.set(value, key)
    }
  }
  return index
}

/**
 * 复用项目真实 ESLint flat config 跑 lint，返回每文件的中文硬编码违规消息
 * （ruleId === 'no-restricted-syntax'）。即便 0 违规的文件也会出现在返回的 map 中（空数组），
 * 以便 prune / guard 能正确统计"已清零"文件。
 */
export async function lintI18nMessages(
  files: string[]
): Promise<Map<string, Linter.LintMessage[]>> {
  // ESLint 的 lintFiles([]) 语义是"lint 全仓"，与调用方"检查指定清单"意图相悖；
  // 白名单收敛到空集时必须返回空结果，避免把全仓 0 违规文件误判为"滞后清零"
  if (files.length === 0) return new Map()
  const eslint = new ESLint({ cwd: ROOT })
  const results = await eslint.lintFiles(files)
  const map = new Map<string, Linter.LintMessage[]>()
  for (const r of results) {
    const file = path.relative(ROOT, r.filePath).split(path.sep).join('/')
    const msgs = r.messages.filter((m) => m.ruleId === 'no-restricted-syntax')
    map.set(file, msgs)
  }
  return map
}

/** 返回每文件违规数与首处位置（基于 lintI18nMessages 聚合）。 */
export async function lintNoRestrictedSyntax(files: string[]): Promise<Map<string, FileStat>> {
  const msgMap = await lintI18nMessages(files)
  const map = new Map<string, FileStat>()
  for (const [file, msgs] of msgMap) {
    map.set(file, {
      file,
      violations: msgs.length,
      loc: msgs.map((m) => ({ line: m.line ?? 0, col: m.column ?? 0 }))
    })
  }
  return map
}
