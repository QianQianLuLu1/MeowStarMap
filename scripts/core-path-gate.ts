/**
 * 核心路径授权闸门（提交面 diff 判定）
 *
 * 与 ESLint 的 local/core-path-guard 构成两层闸门（口径见 AGENTS.md「核心路径保护」）：
 *   - ESLint（静态格式护栏）：不强制要求 @core-change 授权注释存在；一旦存在，
 *     校验「至多一条、原因非空、不得为批量占位文案」。
 *   - 本脚本（提交面闸门）：对本次 diff（pre-commit 为暂存区，verify 为工作区）判定
 *     「受保护文件存在实质改动 ⇒ 必须同批新增一行含真实原因的授权注释」，
 *     让授权与改动建立关联，而不是一次恒真的存在性检查。
 *
 * 用法：
 *   tsx scripts/core-path-gate.ts            # 工作区 diff（git diff HEAD + 未跟踪新文件）
 *   tsx scripts/core-path-gate.ts --staged   # 暂存区 diff（pre-commit 使用）
 *   tsx scripts/core-path-gate.ts a.ts b.ts  # 仅检查指定文件（自动过滤出受保护路径）
 *
 * 退出码：0 通过/跳过；1 存在违规。
 * 本模块同时导出纯函数供 scripts/__tests__/core-path-gate.test.ts 单测；
 * CLI 仅在以脚本方式直接运行时启动。
 * 安全约定：所有 git 调用的参数数组均为字面量，唯一的动态值（文件路径）
 * 一律置于 `--` 之后的位置参数位，不接受选项注入；参与判定的路径已先经
 * isProtectedPath 白名单过滤。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 与 eslint.config.js 中 core-path-guard 各块的 files 并集保持一致（漂移由单测守护） */
export const PROTECTED_DIRS = [
  'src/main/preload/api',
  'src/main/ipc/handlers',
  'src/main/services',
  'src/shared/errors'
] as const

/** 同上，glob 形态（用于文档与对外展示） */
export const PROTECTED_GLOBS = [
  'src/main/preload/api/**/*.ts',
  'src/main/ipc/handlers/**/*.ts',
  'src/main/services/**/*.ts',
  'src/shared/errors/**/*.ts'
] as const

/** 批量初始化占位文案：任何新增授权注释都不得再使用（避免恒真前置条件回归） */
export const BATCH_INIT_REASON = '核心路径保护规则初始化'

const HANDLERS_DIR = 'src/main/ipc/handlers'

const AUTH_COMMENT_RE = /^\s*\/\/\s*@core-change:\s?(.*)$/

export interface ParsedDiff {
  /** 新增行内容（不含 diff 的 +/- 标记） */
  added: string[]
  /** 删除行内容（不含 diff 的 +/- 标记） */
  removed: string[]
  isNewFile: boolean
  isDeleted: boolean
}

export interface DiffAnalysis {
  /** 是否存在授权注释之外的实质增删（空行与授权注释行本身不计） */
  substantive: boolean
  /** 本次 diff 新增授权注释的原因列表 */
  addedAuthReasons: string[]
  /** 本次 diff 移除的授权注释行数（清理过期标记属合法操作） */
  removedAuthCount: number
  isNewFile: boolean
  isDeleted: boolean
}

export type GateViolationType = 'missing-auth' | 'empty-reason' | 'batch-text'

export interface GateEntry {
  path: string
  /** git name-status 的状态位（A/M/R…；D 表示删除） */
  status: string
  analysis: DiffAnalysis
}

export interface GateViolation {
  path: string
  type: GateViolationType
  reason?: string
}

/**
 * 判定路径是否处于核心路径保护范围内。
 * 口径对齐 eslint.config.js：4 个受保护目录下的 .ts；
 * 排除 *.test.ts / *.spec.ts / __tests__/（测试豁免块）与 handlers 下 `_` 前缀共享文件（块级 ignores）。
 */
export function isProtectedPath(p: string): boolean {
  const normalized = p.replace(/\\/g, '/')
  if (!normalized.endsWith('.ts')) return false
  const segments = normalized.split('/')
  if (segments.some((s) => s === '__tests__')) return false
  const base = segments[segments.length - 1]
  if (/\.test\.tsx?$/.test(base) || /\.spec\.tsx?$/.test(base)) return false
  const dir = segments.slice(0, -1).join('/')
  const matched = (PROTECTED_DIRS as readonly string[]).find(
    (d) => dir === d || dir.startsWith(`${d}/`)
  )
  if (!matched) return false
  if (matched === HANDLERS_DIR && base.startsWith('_')) return false
  return true
}

/**
 * 解析单文件的 unified diff 文本。
 * 仅支持单文件 diff（本脚本通过 git 逐文件获取，天然满足）；
 * hunk 之前的元数据行（diff/index/---/+++ 等）不参与增删统计。
 */
export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const added: string[] = []
  const removed: string[] = []
  let isNewFile = false
  let isDeleted = false
  let inHunk = false

  for (const rawLine of diffText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!inHunk) {
      if (line.startsWith('@@')) {
        inHunk = true
      } else if (line.startsWith('new file mode')) {
        isNewFile = true
      } else if (line.startsWith('deleted file mode')) {
        isDeleted = true
      }
      continue
    }
    if (line.startsWith('@@')) continue
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) added.push(line.slice(1))
    else if (line.startsWith('-')) removed.push(line.slice(1))
  }
  return { added, removed, isNewFile, isDeleted }
}

/**
 * 从一行（diff 内容行，容忍残留 +/- 标记、BOM 前缀与 CRLF）中提取 @core-change 授权原因。
 * 非授权注释行返回 null；授权注释缺原因时返回空字符串。
 */
export function extractAuthReason(rawLine: string): string | null {
  const line = rawLine
    .replace(/^[+-]/, '')
    .replace(/^\uFEFF/, '')
    .replace(/\r$/, '')
  const match = line.match(AUTH_COMMENT_RE)
  if (!match) return null
  return match[1].trim()
}

/** 对单文件 diff 做闸门所需的信号分析 */
export function analyzeProtectedDiff(diffText: string): DiffAnalysis {
  const parsed = parseUnifiedDiff(diffText)
  let substantive = false
  const addedAuthReasons: string[] = []
  let removedAuthCount = 0

  const isBlank = (content: string): boolean => content.replace(/^\uFEFF/, '').trim() === ''

  for (const line of parsed.added) {
    const reason = extractAuthReason(line)
    if (reason !== null) {
      addedAuthReasons.push(reason)
      continue
    }
    if (!isBlank(line)) substantive = true
  }
  for (const line of parsed.removed) {
    if (extractAuthReason(line) !== null) {
      removedAuthCount++
      continue
    }
    if (!isBlank(line)) substantive = true
  }
  return {
    substantive,
    addedAuthReasons,
    removedAuthCount,
    isNewFile: parsed.isNewFile,
    isDeleted: parsed.isDeleted
  }
}

/** 闸门判定：删除文件跳过；实质改动必须同批新增有效授权注释；授权原因本身不得为空/批量占位 */
export function evaluateGate(entries: GateEntry[]): GateViolation[] {
  const violations: GateViolation[] = []
  for (const entry of entries) {
    if (entry.status === 'D' || entry.analysis.isDeleted) continue
    const { substantive, addedAuthReasons } = entry.analysis
    if (substantive && addedAuthReasons.length === 0) {
      violations.push({ path: entry.path, type: 'missing-auth' })
    }
    for (const reason of addedAuthReasons) {
      if (reason === '') {
        violations.push({ path: entry.path, type: 'empty-reason' })
      } else if (reason === BATCH_INIT_REASON) {
        violations.push({ path: entry.path, type: 'batch-text', reason })
      }
    }
  }
  return violations
}

// ── CLI 部分 ──
// 每个 git 调用点的参数数组均为字面量；动态值仅限 `--` 之后的路径位置参数。

interface GitRunResult {
  status: number | null
  stdout: string
  stderr: string
}

function requireGitOk(result: GitRunResult, label: string): string {
  if (result.status !== 0) {
    console.error(`[CORE-GATE] ✗ git ${label} 失败：${result.stderr.trim()}`)
    process.exit(1)
  }
  return result.stdout
}

function runGitLiteral(cwd: string, literalArgs: readonly string[]): GitRunResult {
  const result = spawnSync('git', [...literalArgs], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

function gitNameStatus(cwd: string, staged: boolean): ChangeTarget[] {
  const output = staged
    ? requireGitOk(
        runGitLiteral(cwd, ['diff', '--cached', '--name-status', '--diff-filter=ACMR']),
        'diff --cached --name-status'
      )
    : requireGitOk(
        runGitLiteral(cwd, ['diff', 'HEAD', '--name-status', '--diff-filter=ACMR']),
        'diff HEAD --name-status'
      )
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields = line.split('\t')
      // 重命名条目形如 "R100\t旧路径\t新路径"，取新路径参与判定
      const path = fields[fields.length - 1] ?? ''
      const status = fields[0]?.charAt(0) ?? 'M'
      return { path, status, isUntracked: false }
    })
    .filter((t) => t.path !== '')
}

function gitListUntracked(cwd: string): string[] {
  const output = requireGitOk(
    runGitLiteral(cwd, ['ls-files', '--others', '--exclude-standard']),
    'ls-files --others'
  )
  return output.split('\n').filter(Boolean)
}

function gitIsTracked(cwd: string, path: string): boolean {
  const output = requireGitOk(runGitLiteral(cwd, ['ls-files', '--', path]), 'ls-files')
  return output.trim() !== ''
}

function gitFileDiff(cwd: string, staged: boolean, path: string): string {
  return staged
    ? requireGitOk(runGitLiteral(cwd, ['diff', '--cached', '--', path]), `diff --cached -- ${path}`)
    : requireGitOk(runGitLiteral(cwd, ['diff', 'HEAD', '--', path]), `diff HEAD -- ${path}`)
}

interface ChangeTarget {
  path: string
  status: string
  isUntracked: boolean
}

function collectTargets(cwd: string, staged: boolean, positional: string[]): ChangeTarget[] {
  if (positional.length > 0) {
    return positional
      .filter(isProtectedPath)
      .map((path) => ({ path, status: 'M', isUntracked: false }))
  }
  const targets = gitNameStatus(cwd, staged)
  if (!staged) {
    // git diff HEAD 不展示未跟踪文件，工作区模式需补齐（新受保护文件同样受闸门约束）
    for (const line of gitListUntracked(cwd)) {
      targets.push({ path: line, status: 'A', isUntracked: true })
    }
  }
  return targets
}

function readUntrackedAsDiff(cwd: string, path: string): string {
  const content = readFileSync(resolve(cwd, path), 'utf-8')
  return content
    .split('\n')
    .map((l) => `+${l.replace(/\r$/, '')}`)
    .join('\n')
}

function getDiffText(cwd: string, target: ChangeTarget, staged: boolean): string {
  if (target.isUntracked) {
    return readUntrackedAsDiff(cwd, target.path)
  }
  const diff = gitFileDiff(cwd, staged, target.path)
  if (diff.trim() === '' && !staged && !gitIsTracked(cwd, target.path)) {
    // 显式传入的未跟踪文件：git diff HEAD 不可见，按全新增处理
    return readUntrackedAsDiff(cwd, target.path)
  }
  return diff
}

function describeViolation(v: GateViolation): string {
  switch (v.type) {
    case 'missing-auth':
      return '实质改动缺少本次授权：需在同批 diff 中新增一行 "// @core-change: <本次真实原因>"'
    case 'empty-reason':
      return '@core-change 注释缺少变更原因'
    case 'batch-text':
      return `@core-change 原因不得使用批量占位文案「${v.reason}」，请替换为本次真实原因`
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const staged = args.includes('--staged')
  const positional = args.filter((a) => !a.startsWith('--'))
  const cwd = process.cwd()
  const modeLabel = staged ? '暂存区 diff' : '工作区 diff'

  console.log(`[CORE-GATE] ▶ 核心路径授权闸门（${modeLabel}判定）`)

  const targets = collectTargets(cwd, staged, positional).filter((t) => isProtectedPath(t.path))
  if (targets.length === 0) {
    console.log('[CORE-GATE] ⊘ 本次变更不涉及核心路径受保护文件，跳过')
    process.exit(0)
  }

  const entries: GateEntry[] = targets.map((t) => ({
    path: t.path,
    status: t.status,
    analysis: analyzeProtectedDiff(getDiffText(cwd, t, staged))
  }))
  const violations = evaluateGate(entries)

  if (violations.length > 0) {
    for (const v of violations) {
      console.log(`[CORE-GATE] ✗ ${v.path} — ${describeViolation(v)}`)
    }
    console.log(`[CORE-GATE] ✗ 闸门未通过：${violations.length} 处违规（${modeLabel}）`)
    console.log(
      '[CORE-GATE] 修复方式：为存在实质改动的受保护文件，在本次变更中新增/替换一条顶部注释 "// @core-change: <本次真实中文原因>"（随同一批改动提交，旧原因不复用）'
    )
    process.exit(1)
  }
  console.log(`[CORE-GATE] ✓ 核心路径授权闸门通过（${targets.length} 个受保护文件）`)
  process.exit(0)
}

// 仅在以脚本方式直接运行（tsx scripts/core-path-gate.ts）时启动 CLI；被测试导入时不执行
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('core-path-gate.ts')) {
  main()
}
