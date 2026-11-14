/**
 * 文档版本一致性校验脚本
 *
 * 解析 package.json 中声明的 Electron 版本范围（devDependencies 优先，回退 dependencies），
 * 取 major.minor 作为可比较的展示版本，校验 README.md 中所有 "Electron <version>" 字符串是否与之匹配。
 * 任一不匹配则以非零退出码阻止打包，并打印差异。
 *
 * 2026-11-14 扩展：通用「计数类断言」能力（盘点对账守护）。每条断言从一个代码事实源
 * 提取计数，与登记基线比对：
 *   - 实测 = 基线   → ✓ 通过；
 *   - 实测 ≠ 基线   → ⚠ 漂移提醒（打印带符号差值与对账指引，不阻断打包——功能轮正常演进
 *                      不应被数字红灯卡住，对账动作由人工在盘点轮完成）；
 *   - 事实源丢失/零命中 → ✖ 守护锚点失效（阻断，exit 1——锚点烂掉比漂移更危险，必须响亮失败）。
 *
 * 用法：npx tsx scripts/check-doc-versions.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

// ============ 计数类断言（通用框架） ============

/** 计数事实源：单文件正则 / 目录树正则（可排除测试文件）/ 目录常规文件清单。路径均为绝对路径。 */
export interface CountSource {
  kind: 'regex-in-file' | 'regex-in-tree' | 'files-in-dir'
  /** regex-in-file / files-in-dir 使用 */
  file?: string
  dir?: string
  /** regex-in-* 使用：带 g 标志的计数正则 */
  pattern?: RegExp
  /** 可选：文件路径白名单（如 /\.ts$/——文档/配置中的字样不计入计数） */
  include?: RegExp
  /** 可选：文件路径排除（如 /\.test\.ts$|__tests__/） */
  exclude?: RegExp
}

export interface CountAssertion {
  /** 稳定 id，输出与对账指引都用它 */
  id: string
  source: CountSource
  /** 登记基线（盘点轮人工更新） */
  baseline: number
  /** 漂移时打印的人工对账指引 */
  hint: string
}

export type CollectedCount = { ok: true; value: number } | { ok: false; reason: string }

export interface CountResult {
  id: string
  blocked: boolean
  warned: boolean
  detail: string
}

/** 从事实源收集计数。文件/目录缺失、读取失败、零命中一律视为锚点失效（不返回 0）。 */
export function collectCount(source: CountSource): CollectedCount {
  if (source.kind === 'regex-in-file') {
    if (!source.file || !source.pattern)
      return { ok: false, reason: '事实源配置不完整（file/pattern 缺失）' }
    if (!fs.existsSync(source.file))
      return { ok: false, reason: `事实源文件不存在：${source.file}` }
    let text: string
    try {
      text = fs.readFileSync(source.file, 'utf-8')
    } catch (error) {
      return { ok: false, reason: `事实源文件不可读：${source.file}（${String(error)}）` }
    }
    return countMatches(text, source.pattern, source.file)
  }

  if (source.kind === 'regex-in-tree') {
    if (!source.dir || !source.pattern)
      return { ok: false, reason: '事实源配置不完整（dir/pattern 缺失）' }
    if (!fs.existsSync(source.dir)) return { ok: false, reason: `事实源目录不存在：${source.dir}` }
    let total = 0
    let hitFile = false
    for (const file of walkTree(source.dir)) {
      if (source.include && !source.include.test(file)) continue
      if (source.exclude && source.exclude.test(file)) continue
      let text: string
      try {
        text = fs.readFileSync(file, 'utf-8')
      } catch {
        return { ok: false, reason: `事实源树内有不可读文件：${file}` }
      }
      const matches = text.match(source.pattern)
      if (matches && matches.length > 0) {
        total += matches.length
        hitFile = true
      }
    }
    if (!hitFile) return { ok: false, reason: `事实源树零命中（锚点语义可能已变）：${source.dir}` }
    return { ok: true, value: total }
  }

  // files-in-dir
  if (!source.dir) return { ok: false, reason: '事实源配置不完整（dir 缺失）' }
  if (!fs.existsSync(source.dir)) return { ok: false, reason: `事实源目录不存在：${source.dir}` }
  const entries = fs.readdirSync(source.dir, { withFileTypes: true })
  const count = entries.filter(
    (entry) => entry.isFile() && (!source.exclude || !source.exclude.test(entry.name))
  ).length
  if (count === 0)
    return { ok: false, reason: `事实源目录零文件（锚点语义可能已变）：${source.dir}` }
  return { ok: true, value: count }
}

function countMatches(text: string, pattern: RegExp, label: string): CollectedCount {
  const matches = text.match(pattern)
  if (!matches || matches.length === 0)
    return { ok: false, reason: `事实源零命中（锚点语义可能已变）：${label}` }
  return { ok: true, value: matches.length }
}

function walkTree(dir: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkTree(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

function formatDelta(delta: number): string {
  return delta >= 0 ? `+${delta}` : `${delta}`
}

/** 基线比对：一致 → 通过；漂移 → warn；收集失败 → 阻断。 */
export function evaluateCountAssertion(
  assertion: CountAssertion,
  got: CollectedCount
): CountResult {
  if (!got.ok) {
    return { id: assertion.id, blocked: true, warned: false, detail: `守护锚点失效：${got.reason}` }
  }
  if (got.value === assertion.baseline) {
    return {
      id: assertion.id,
      blocked: false,
      warned: false,
      detail: `实测 ${got.value}，与基线一致`
    }
  }
  const delta = got.value - assertion.baseline
  return {
    id: assertion.id,
    blocked: false,
    warned: true,
    detail: `基线 ${assertion.baseline} → 实测 ${got.value} (${formatDelta(delta)})。请人工对账：${assertion.hint}`
  }
}

/**
 * 内置断言表（基线 = 2026-11-14 盘点实测，口径与 scripts/__tests__/check-doc-versions.test.ts 相同）。
 * 漂移不阻断；盘点轮对账后人工更新基线。
 */
export const COUNT_ASSERTIONS: readonly CountAssertion[] = [
  {
    id: 'ipc-handler-call-sites',
    source: {
      kind: 'regex-in-tree',
      dir: path.join(ROOT, 'src', 'main'),
      pattern: /ipcMain\.handle\(/g,
      include: /\.ts$/,
      exclude: /\.test\.ts$|__tests__/
    },
    baseline: 240,
    hint: 'docs/IPC_CONTRACT.md 是否补录新通道；handler 分布见 src/main/ipc/handlers/'
  },
  {
    id: 'preload-api-namespaces',
    source: {
      kind: 'files-in-dir',
      dir: path.join(ROOT, 'src', 'main', 'preload', 'api')
    },
    baseline: 34,
    hint: 'electronAPI 命名空间清单见 src/main/preload.ts 与 docs/IPC_CONTRACT.md'
  }
]

// ============ Electron 版本校验（原有逻辑，输出格式保持不变） ============

function majorMinor(range: string): string {
  const cleaned = range.replace(/^[\^~>=<\s]+/, '').split('.')
  return `${cleaned[0]}.${cleaned[1] ?? '0'}`
}

/** @returns true = 通过或跳过；false = 已打印失败（阻断）。 */
function checkElectronVersions(): boolean {
  console.log('\n[check-doc-versions] 校验 README 中 Electron 版本与 package.json 一致\n')

  const pkgPath = path.join(ROOT, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    console.error('[check-doc-versions] ✖ 未找到 package.json')
    return false
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Pkg

  const range = pkg.devDependencies?.electron ?? pkg.dependencies?.electron
  if (!range) {
    console.error(
      '[check-doc-versions] ✖ package.json 未声明 electron 依赖（dependencies / devDependencies）'
    )
    return false
  }
  const expected = majorMinor(range)

  const readmePath = path.join(ROOT, 'README.md')
  if (!fs.existsSync(readmePath)) {
    // README 不存在（已从仓库移除）时，文档一致性校验无对象，跳过即可，不阻断打包。
    console.log(
      '[check-doc-versions] ⚠ 未找到 README.md，跳过 README 版本一致性校验（不影响打包）\n'
    )
    return true
  }
  const readme = fs.readFileSync(readmePath, 'utf-8')

  const re = /Electron[ -](\d+\.\d+(?:\.\d+)?)/g
  const found = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(readme)) !== null) found.add(m[1])

  if (found.size === 0) {
    console.error('[check-doc-versions] ✖ README.md 中未找到任何 Electron 版本字符串')
    return false
  }

  const mismatches = [...found].filter((v) => majorMinor(v) !== expected)
  if (mismatches.length > 0) {
    console.error('[check-doc-versions] ❌ README 中 Electron 版本与 package.json 不一致：')
    console.error(`  package.json electron: ${range}  (期望 major.minor = ${expected})`)
    console.error(`  README 中不匹配的版本: ${mismatches.join(', ')}`)
    console.error('  请同步修改 README.md 中的 Electron 版本（徽章与技术栈表格）。\n')
    return false
  }

  console.log(
    `[check-doc-versions] ✅ README 中所有 Electron 版本均为 ${expected}，与 package.json (${range}) 一致。\n`
  )
  return true
}

/** @returns true = 全部通过（允许 warn）；false = 存在锚点失效（阻断）。 */
function runCountAssertions(): boolean {
  console.log('[check-doc-versions] 计数断言（漂移提醒不阻断，锚点失效阻断）：')
  let blocked = 0
  for (const assertion of COUNT_ASSERTIONS) {
    const result = evaluateCountAssertion(assertion, collectCount(assertion.source))
    const mark = result.blocked ? '✖' : result.warned ? '⚠' : '✓'
    console.log(`  ${mark} ${result.id} — ${result.detail}`)
    if (result.blocked) blocked += 1
  }
  console.log('')
  return blocked === 0
}

function main(): void {
  const versionOk = checkElectronVersions()
  const countsOk = runCountAssertions()
  process.exit(versionOk && countsOk ? 0 : 1)
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
