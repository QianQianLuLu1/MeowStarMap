/**
 * 技术债修复 CI 检查脚本
 *
 * 当 PR 变更的源码文件命中 docs/debt-registry.json 中已登记的技术债条目时，
 * 输出 GitHub Actions ::warning:: 注解提醒开发者：
 *   1. 若修复了债务 → 关闭对应 GitHub Issue + 更新 docs/技术债清单.md + 更新 debt-registry.json
 *   2. 若未修复（仅重构等） → 无需操作，注解可忽略
 *
 * 同时检查：当债务文件被变更但 docs/技术债清单.md 与 docs/debt-registry.json
 * 未同步出现在 diff 中时，输出额外提醒。
 *
 * 退出码：始终 0（提醒性质，不阻断 CI）。
 *
 * 用法：
 *   npx tsx scripts/debt/check-debt-fix.ts                        # 本地：git diff HEAD~1
 *   npx tsx scripts/debt/check-debt-fix.ts --base BASE --head HEAD # 指定 diff 范围
 *   npx tsx scripts/debt/check-debt-fix.ts --files-from <file>     # 从文件读取变更列表（每行一个路径）
 *
 * CI 环境变量（GitHub Actions PR 场景自动识别）：
 *   GITHUB_EVENT_NAME=pull_request → 从 event payload 提取 base/head sha
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const REGISTRY_PATH = path.join(ROOT, 'docs', 'debt-registry.json')

interface DebtItem {
  id: string
  category: string
  section: number
  status: string
  priority: string
  title: string
  description: string
  files: string[]
  lines: number[]
  issue: number | false | null
}

interface Registry {
  updatedAt: string
  items: DebtItem[]
}

const isCI = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true'

function emitWarning(message: string, file?: string): void {
  if (isCI) {
    // GitHub Actions 注解格式
    const fileAttr = file ? ` file=${file}` : ''
    console.log(`::warning title=技术债跟踪${fileAttr}::${message}`)
  } else {
    console.log(`⚠  ${message}`)
  }
}

function emitInfo(message: string): void {
  if (isCI) {
    console.log(message)
  } else {
    console.log(`ℹ  ${message}`)
  }
}

/** 获取 PR 变更文件列表（GitHub Actions PR 场景） */
function getChangedFilesFromCI(): string[] | null {
  const eventName = process.env['GITHUB_EVENT_NAME']
  if (eventName !== 'pull_request') return null

  // 从 event payload 读取 base/head sha
  const eventPath = process.env['GITHUB_EVENT_PATH']
  if (!eventPath || !fs.existsSync(eventPath)) return null

  try {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'))
    const baseSha = event?.pull_request?.base?.sha
    const headSha = event?.pull_request?.head?.sha
    if (!baseSha || !headSha) return null

    const result = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=ACMR', `${baseSha}...${headSha}`],
      { encoding: 'utf-8', cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    return result.trim().split('\n').filter(Boolean)
  } catch {
    return null
  }
}

/** 获取变更文件列表（本地 git diff） */
function getChangedFilesLocal(base?: string, head?: string): string[] {
  const args = ['diff', '--name-only', '--diff-filter=ACMR']
  if (base && head) {
    args.push(`${base}...${head}`)
  } else if (base) {
    args.push(base)
  } else {
    args.push('HEAD~1')
  }
  try {
    const result = execFileSync('git', args, {
      encoding: 'utf-8',
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return result.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** 从文件读取变更列表 */
function getChangedFilesFromFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    console.error(`[check-debt-fix] ✖ 变更文件列表不存在: ${filePath}`)
    return []
  }
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function main(): void {
  console.log('\n[check-debt-fix] 技术债修复跟踪检查')
  console.log(`  注册表: ${REGISTRY_PATH}`)
  console.log(`  CI 模式: ${isCI ? '是' : '否'}\n`)

  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error('[check-debt-fix] ✖ 注册表文件不存在:', REGISTRY_PATH)
    process.exit(1)
  }

  const registry: Registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'))

  // 解析命令行参数
  const args = process.argv.slice(2)
  const baseIdx = args.indexOf('--base')
  const headIdx = args.indexOf('--head')
  const filesFromIdx = args.indexOf('--files-from')

  let changedFiles: string[]

  if (filesFromIdx >= 0 && args[filesFromIdx + 1]) {
    changedFiles = getChangedFilesFromFile(args[filesFromIdx + 1])
  } else {
    // 优先尝试 CI 环境
    const ciFiles = getChangedFilesFromCI()
    if (ciFiles) {
      changedFiles = ciFiles
    } else {
      const base = baseIdx >= 0 ? args[baseIdx + 1] : undefined
      const head = headIdx >= 0 ? args[headIdx + 1] : undefined
      changedFiles = getChangedFilesLocal(base, head)
    }
  }

  if (changedFiles.length === 0) {
    console.log('[check-debt-fix] ✓ 无变更文件，跳过检查')
    process.exit(0)
  }

  console.log(`  变更文件数: ${changedFiles.length}`)

  // 检查 docs 文件是否在 diff 中
  const debtDocChanged = changedFiles.some(
    (f) => f === 'docs/技术债清单.md' || f === 'docs/debt-registry.json'
  )

  // 交叉比对：变更文件 vs 债务条目
  const matchedItems: Array<{ item: DebtItem; matchedFiles: string[] }> = []

  for (const item of registry.items) {
    // 跳过已关闭 / 不处理的条目
    if (item.status === 'done' || item.status === 'wont_fix') continue
    if (item.files.length === 0) continue

    const matchedFiles = item.files.filter((debtFile) => changedFiles.includes(debtFile))

    if (matchedFiles.length > 0) {
      matchedItems.push({ item, matchedFiles })
    }
  }

  if (matchedItems.length === 0) {
    console.log('\n[check-debt-fix] ✓ 变更文件未命中任何已登记的技术债条目')
    process.exit(0)
  }

  // 输出提醒
  console.log(`\n[check-debt-fix] ⚠  ${matchedItems.length} 个技术债条目涉及本次变更的文件：\n`)

  for (const { item, matchedFiles } of matchedItems) {
    const issueRef = item.issue ? `#${item.issue}` : '（未创建 Issue）'
    const fileDesc = matchedFiles.map((f) => `\`${f}\``).join(', ')

    const msg = [
      `债务 ${item.id}「${item.title}」涉及本次变更的文件：${fileDesc}`,
      `关联 Issue：${issueRef}`,
      item.issue
        ? '若本次变更修复了该债务，请：① 关闭对应 Issue  ② 更新 docs/技术债清单.md 标记为已完成  ③ 更新 docs/debt-registry.json 的 status 为 done'
        : '若本次变更修复了该债务，请创建 GitHub Issue 并更新 docs/技术债清单.md 与 docs/debt-registry.json'
    ].join(' | ')

    emitWarning(msg, matchedFiles[0])
  }

  // 额外检查：债务文件变更但文档未同步更新
  if (!debtDocChanged) {
    emitInfo(
      '\n💡 提示：技术债相关源码文件已变更，但 docs/技术债清单.md 与 docs/debt-registry.json 未出现在 diff 中。\n' +
        '   若修复了债务，请同步更新上述文档；若未修复（仅重构等），可忽略此提示。'
    )
  }

  console.log(
    `\n[check-debt-fix] 检查完成：${matchedItems.length} 条提醒` +
      (debtDocChanged ? '（文档已同步 ✓）' : '')
  )

  // 始终退出 0——提醒性质，不阻断 CI
  process.exit(0)
}

main()
