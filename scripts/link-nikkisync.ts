/**
 * NikkiSync 开发机链接器（阶段 9 · 问题 2）。
 *
 * 为什么存在：XiangCe 的 CI 只 checkout 本仓库，`package.json` 里的
 * `file:../NikkiSync/...` 声明依赖会让 `npm ci` 必然失败，并让 `tsc -b` 在缺失同级仓库的
 * 机器上报 4×TS2307（取证见 docs/sync-integration/09-legacy-debt-remediation-plan.md §0）。
 * 因此自包含方案把 @nikkisync/* 从声明依赖中移出：主进程装载缝保持"变量式动态 import"，
 * 链接改由本命令在开发机显式建立；未链接是受支持的默认态（相关测试 skip、诊断降为 warn）。
 *
 * 用法：
 *   npm run link:nikkisync            建立/校正四条 junction（幂等）
 *   npm run link:nikkisync:check      只读：报告现状，不写盘
 *   NIKKISYNC_ROOT=<绝对路径> npm run link:nikkisync   指定 NikkiSync 检出根
 *
 * 候选根优先级：NIKKISYNC_ROOT 环境变量 → 同级 ../NikkiSync → 仓内 vendor/NikkiSync。
 * Windows 用 junction（无需管理员/开发者模式），其余平台回落 dir 软链。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 包名 → NikkiSync 仓库内的包目录（相对根，禁止 .. 逃逸，由 validateRequiredSubpaths 把关）。 */
export const NIKKISYNC_PACKAGE_DIRS: Record<string, string> = {
  '@nikkisync/core': 'packages/core',
  '@nikkisync/database': 'packages/database',
  '@nikkisync/protocol': 'packages/protocol',
  '@nikkisync/pc-companion': 'apps/pc-companion'
}

export type RootCandidateSource = 'env' | 'sibling' | 'vendor'

export interface RootCandidate {
  path: string
  source: RootCandidateSource
}

export interface RootResolution {
  root?: string
  source?: RootCandidateSource
  /** 被拒绝的候选及原因（空数组 = 无候选可用），用于给用户可执行的修复提示。 */
  rejected: Array<{ path: string; reason: string }>
}

export type LinkAction = 'create' | 'skip' | 'replace'

export interface LinkPlanItem {
  name: string
  link: string
  target: string
  action: LinkAction
  /** replace 时记录旧目标，作为回滚线索打进日志。 */
  currentTarget?: string
}

/** 平台差异化的路径等价比较（Windows 大小写不敏感）。 */
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * 生成候选根清单。env 值为空/纯空白时忽略该候选（不当成"用户已指定但失败"），
 * 避免 CI 里未设置的空环境变量把合法回落路径挡掉。
 * env 值走 path.resolve（用户可能给相对路径，需按当前工作目录归一为绝对路径）；
 * 内置候选走 path.join（projectRoot 已为绝对路径，拼接保持其原形，不跨盘符改写）。
 */
export function toRootCandidates(input: {
  projectRoot: string
  envRoot?: string
}): RootCandidate[] {
  const candidates: RootCandidate[] = []
  const envRoot = input.envRoot?.trim()
  if (envRoot) {
    candidates.push({ path: path.resolve(envRoot), source: 'env' })
  }
  candidates.push({ path: path.join(input.projectRoot, '..', 'NikkiSync'), source: 'sibling' })
  candidates.push({
    path: path.join(input.projectRoot, 'vendor', 'NikkiSync'),
    source: 'vendor'
  })
  return candidates
}

/** 入参校验：必需子路径必须是非空清单，且每段都是仓内相对路径（禁绝对路径与 .. 逃逸）。 */
export function validateRequiredSubpaths(subpaths: readonly string[]): void {
  if (subpaths.length === 0) {
    throw new Error('validateRequiredSubpaths: empty subpath list is not allowed')
  }
  for (const sub of subpaths) {
    const segments = sub.split(/[\\/]/).filter((segment) => segment !== '')
    const illegal = sub.startsWith('/') || sub.startsWith('\\') || segments.includes('..')
    if (illegal) {
      throw new Error(
        `validateRequiredSubpaths: illegal subpath "${sub}" (absolute or ".." escape)`
      )
    }
  }
}

/**
 * 纯函数：在候选根里挑出第一个"四个包目录齐全"的根。
 * isDirectory 注入以便单测不触磁盘；缺目录的候选进 rejected 清单并列出具体缺失项。
 */
export function resolveNikkiSyncRoot(
  candidates: readonly RootCandidate[],
  isDirectory: (p: string) => boolean,
  subpaths: readonly string[] = Object.values(NIKKISYNC_PACKAGE_DIRS)
): RootResolution {
  validateRequiredSubpaths(subpaths)
  const rejected: RootResolution['rejected'] = []
  for (const candidate of candidates) {
    const missing = subpaths.filter((sub) => !isDirectory(path.join(candidate.path, sub)))
    if (missing.length === 0) {
      return { root: candidate.path, source: candidate.source, rejected }
    }
    rejected.push({ path: candidate.path, reason: `missing ${missing.join(', ')}` })
  }
  return { rejected }
}

/**
 * 纯函数：由链接现状推导动作表。
 * linkExists=false → create；目标 realpath 与期望一致 → skip；指向别处 → replace。
 * 根为空（尚未解析出 NikkiSync 检出）时返回空计划，调用方不得写盘。
 */
export function planLinks(input: {
  root: string
  projectRoot: string
  linkExists: (name: string) => boolean
  realPathOf: (name: string) => string | undefined
}): LinkPlanItem[] {
  if (!input.root) return []
  return Object.entries(NIKKISYNC_PACKAGE_DIRS).map(([name, subpath]) => {
    const target = path.join(input.root, subpath)
    const link = path.join(input.projectRoot, 'node_modules', name)
    if (!input.linkExists(name)) {
      return { name, link, target, action: 'create' as const }
    }
    const currentTarget = input.realPathOf(name)
    if (currentTarget && samePath(currentTarget, target)) {
      return { name, link, target, action: 'skip' as const }
    }
    return { name, link, target, action: 'replace' as const, currentTarget }
  })
}

// ============================================================================
// I/O 壳（唯一的文件系统写入面）
// ============================================================================

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function linkExistsFor(name: string): boolean {
  return fs.existsSync(path.join(projectRoot, 'node_modules', name))
}

function realPathFor(name: string): string | undefined {
  const link = path.join(projectRoot, 'node_modules', name)
  if (!fs.existsSync(link)) return undefined
  try {
    return fs.realpathSync(link)
  } catch {
    return undefined
  }
}

function main(): void {
  const checkOnly = process.argv.includes('--check')
  const candidates = toRootCandidates({ projectRoot, envRoot: process.env.NIKKISYNC_ROOT })
  const resolution = resolveNikkiSyncRoot(candidates, isDirectory)

  if (!resolution.root) {
    process.stdout.write('[link:nikkisync] no usable NikkiSync checkout found\n')
    for (const item of resolution.rejected) {
      process.stdout.write(`  - rejected ${item.path} (${item.reason})\n`)
    }
    if (resolution.rejected.length === 0) {
      process.stdout.write('  - no candidate path existed to inspect\n')
    }
    process.stdout.write(
      '  fix: clone NikkiSync beside this repo (../NikkiSync) or set NIKKISYNC_ROOT, ' +
        'then re-run `npm run link:nikkisync`\n'
    )
    process.exitCode = 1
    return
  }

  const plan = planLinks({
    root: resolution.root,
    projectRoot,
    linkExists: linkExistsFor,
    realPathOf: realPathFor
  })
  process.stdout.write(
    `[link:nikkisync] root=${resolution.root} source=${resolution.source ?? 'unknown'} mode=${checkOnly ? 'check' : 'apply'}\n`
  )

  let changed = 0
  for (const item of plan) {
    if (item.action === 'skip') {
      process.stdout.write(`  ok      ${item.name} -> ${item.target}\n`)
      continue
    }
    changed += 1
    if (checkOnly) {
      process.stdout.write(
        `  ${item.action.padEnd(7)} ${item.name} -> ${item.target}` +
          `${item.currentTarget ? ` (currently ${item.currentTarget})` : ''}\n`
      )
      continue
    }
    try {
      fs.mkdirSync(path.dirname(item.link), { recursive: true })
      if (item.action === 'replace') {
        fs.rmSync(item.link, { recursive: true, force: true })
      }
      fs.symlinkSync(item.target, item.link, process.platform === 'win32' ? 'junction' : 'dir')
      process.stdout.write(`  ${item.action}    ${item.name} -> ${item.target}\n`)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`  failed  ${item.name}: ${message}\n`)
      process.exitCode = 1
      return
    }
  }

  if (checkOnly && changed > 0) {
    process.stdout.write(
      `[link:nikkisync] NOT linked (${changed} item(s) need action) — run \`npm run link:nikkisync\`\n`
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(
    checkOnly
      ? '[link:nikkisync] check OK (all four links in place)\n'
      : `[link:nikkisync] done (${changed} link(s) written); next: npm run verify:nikkisync\n`
  )
}

const invokedDirectly = (): boolean => {
  const self = path.resolve(fileURLToPath(import.meta.url))
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
  // Windows 盘符大写在两种入口下可能不一致，按小写比较
  return self.toLowerCase() === entry.toLowerCase()
}

if (invokedDirectly()) {
  main()
}
