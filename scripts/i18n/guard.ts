/**
 * i18n 存量白名单 —— CI 守卫
 *
 * 三项硬校验（任一失败则退出码 1，阻断流水线）：
 *  1) 单调性：当前白名单文件集合必须是基线（docs/i18n/whitelist-baseline.json）的子集，
 *     即白名单只减不增，禁止偷偷新增技术债文件。
 *  2) 无滞后：任一仍在白名单中的文件若违规已清零，必须先用 prune-whitelist 移除，
 *     否则视为"已修复却仍 warn"的滞后白名单。
 *  3) key 对齐：11 个语言包必须与 zh-CN.json 的 key 完全对齐（复用 check-i18n-keys 思路）。
 *
 * 用法：npm run i18n:guard   （CI 中接在 npm run lint 之后）
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { lintNoRestrictedSyntax, loadWhitelistFiles, ROOT } from './_shared'

const BASELINE_PATH = path.join(ROOT, 'docs', 'i18n', 'whitelist-baseline.json')

export interface GuardFileStat {
  file: string
  violations: number
  loc: Array<{ line: number; col: number }>
}

export interface GuardInput {
  currentFiles: string[]
  stats: Map<string, GuardFileStat>
  baseline: { files: string[] }
}

/** 纯函数：返回守卫违规说明（空数组表示通过）。供单测复用。 */
export function evaluateGuard(input: GuardInput): string[] {
  const violations: string[] = []
  const baseSet = new Set(input.baseline.files)

  const added = input.currentFiles.filter((f) => !baseSet.has(f))
  if (added.length) {
    violations.push(`白名单不允许新增文件（只减不增）：${added.join(', ')}`)
  }

  for (const [file, st] of input.stats) {
    if (st.violations === 0) {
      violations.push(
        `白名单文件已清零但未移除，请先运行 npm run i18n:prune-whitelist --apply：${file}`
      )
    }
  }
  return violations
}

function flattenKeys(obj: unknown, prefix = ''): string[] {
  const keys: string[] = []
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const full = prefix ? `${prefix}.${k}` : k
      keys.push(full)
      keys.push(...flattenKeys(v, full))
    }
  }
  return keys
}

/** 校验 11 个 locale 与 zh-CN.json 的 key 完全对齐。 */
export function checkKeyAlignment(): string[] {
  const localesDir = path.join(ROOT, 'src', 'renderer', 'i18n', 'locales')
  const baselineKeys = new Set(
    flattenKeys(JSON.parse(fs.readFileSync(path.join(localesDir, 'zh-CN.json'), 'utf-8')))
  )
  const problems: string[] = []
  for (const file of fs
    .readdirSync(localesDir)
    .filter((f) => f.endsWith('.json') && f !== 'zh-CN.json')) {
    const keys = new Set(
      flattenKeys(JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf-8')))
    )
    const missing = [...baselineKeys].filter((k) => !keys.has(k))
    if (missing.length)
      problems.push(`locale ${file} 缺失 ${missing.length} 个 key（需 npm run sync-i18n-keys）`)
  }
  return problems
}

async function main(): Promise<void> {
  const whitelist = await loadWhitelistFiles()
  let baseline = { files: [] as string[] }
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'))
  } catch {
    console.error(
      '[i18n:guard] 未找到白名单基线 docs/i18n/whitelist-baseline.json，请先刷新现状（npm run i18n:status）。'
    )
    process.exit(1)
  }
  const stats = await lintNoRestrictedSyntax(whitelist)
  const violations = [
    ...evaluateGuard({ currentFiles: whitelist, stats, baseline }),
    ...checkKeyAlignment()
  ]
  if (violations.length) {
    console.error('[i18n:guard] 守卫失败：')
    for (const v of violations) console.error(`  - ${v}`)
    process.exit(1)
  }
  console.log('[i18n:guard] ✅ 白名单只减不增、清零必移除、key 已同步，守卫通过。')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
