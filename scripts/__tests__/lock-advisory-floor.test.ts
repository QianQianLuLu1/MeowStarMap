import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * lock 解析版本下限闸门（防回归：把「依赖树里解析出的版本落在已修复通告区间之下」钉成可判定的红）。
 *
 * 为什么要有这个文件：2026-10-27 起 CI 的 `lint-typecheck` job 在第 6 步 `Security audit (audit-ci)`
 * 连续两次变红（run 22 = `df2ab848`、run 21 = `59b40a4`），本机复跑同一条命令退出码 1。根因不是代码
 * 改动——逐 commit 核对 `package-lock.json`，zod 与两条 undici 的版本在 run 20（全绿）与 run 22 之间
 * 一字未变；变的是通告进入 npm 审计源的时间（electron / undici 两条 2026-10-23 披露，zod 那条
 * 2026-10-01 披露、修复版 10-11 发布，但 10-27 才进审计源返回）。也就是说：**同一份 lock 会因外部
 * 数据源而由绿转红，也会由红转绿**。audit 本身要联网、结果随上游漂移，不能当离线回归用；本闸门只读
 * `package-lock.json`，把「我们已经把这几条通告按修复版落地」这件事钉成一条离线可判的断言——将来
 * 有人重装/回退依赖把版本降回漏洞区间，本地 `npm test` 当场红，而不是等下一次 CI。
 *
 * 与 `audit-config.test.ts` 的分工：那个文件是「四处配置一致性契约」（audit-ci.jsonc / package.json /
 * build.yml / .npmrc 的豁免清单与脚本形态），输入是配置文本；本文件输入是 lock 的版本数据，失败语义
 * 完全不同。刻意不扩写进那个文件——它的「19 例全通过」已被 DEBT-020 / DEBT-034 的关闭证据钉住，
 * 加例数会让历史读数不可复现。
 *
 * 互斥断言的用意：同一张通告**要么按修复版落地、要么进豁免清单**，二者只能取其一。若有人为了让本文件
 * 变绿而把 zod / undici 塞进 `audit-ci.jsonc` 的 allowlist，互斥断言会先红——防的是「用放宽安全闸门
 * 的方式关掉回归信号」。
 *
 * 撤销条件（满足任一即删除对应表行并复跑本套件，勿留僵尸条目）：
 * - zod 行：`package.json` 的 `dependencies.zod` 抬到 `^4.6.6` 及以上（声明区间本身已排除漏洞版本）。
 * - 两条 undici 行：上游把 `jsdom` / `node-gyp` 的 undici 区间抬过修复版，或 lock 里对应节点因依赖
 *   结构调整而不复存在（届时「节点存在性」断言会红，按提示删行而非改判据）。
 * 登记面见 `docs/debt-registry.json` 的 DEBT-038 与 `docs/技术债清单.md` §16。
 *
 * 根路径走 `new URL(rel, import.meta.url)` 而非 `path.resolve(dirname(fileURLToPath(...)))`：
 * 与同目录 `pack-identity-name.test.ts` 同一口径——`test:ci-linux` 装置会把宿主 `path` 钉成 posix，
 * 而 `import.meta.url` 是真实路径，posix 下 `dirname('D:\\…')` 返回 '.' 会导致装载即 ENOENT。
 * 本文件不引入任何 win32 钉或方言引用，故无须在 `path-semantics-guard.test.ts` 登记。
 */

const repoRootUrl = new URL('../../', import.meta.url)

/** GHSA 编号格式，与 `audit-config.test.ts` 的 GHSA_PATTERN 同标准（GHSA- 前缀 + 3 组 4 位小写字母/数字） */
const GHSA_PATTERN = /^GHSA(-[a-z0-9]{4}){3}$/

/** 表规模上限：防这张表长成第二份豁免清单，超出即红、逼迫评审 */
const MAX_FLOOR_ROWS = 6

/** lock 里 `packages` 的节点形状（只取本文件用到的字段） */
interface LockPackageNode {
  version?: string
}

interface LockFile {
  packages?: Record<string, LockPackageNode>
}

export interface LockFloorRow {
  /** lock 里 `packages` 的键；不存在即判违规，绝不静默跳过 */
  lockPath: string
  /** 解析版本必须 >= 此下限（含） */
  minVersion: string
  /** 对应通告编号，仅作人读与互斥断言之用 */
  advisory: string
  /** 中文理由：为什么这一行值得钉住 */
  reason: string
}

/**
 * 本轮（2026-10-28）三条未豁免 high 通告里「可在既有区间内真修」的两条。
 * electron 的 GHSA-jr5w-w6x2-84p9 不在此表内：41 线无回移补丁，只能走豁免 + DEBT-038 跟踪。
 */
export const LOCK_FLOORS: readonly LockFloorRow[] = [
  {
    lockPath: 'node_modules/zod',
    minVersion: '4.6.6',
    advisory: 'GHSA-mrhx-c7xc-m3w5',
    reason:
      'zod 是 prod 直接依赖，IPC/preload 入参校验层在用；4.6.6 修复「校验超大受限集合时内存耗尽」'
  },
  {
    lockPath: 'node_modules/undici',
    minVersion: '7.30.1',
    advisory: 'GHSA-xjj6-f33q-929c',
    reason: 'jsdom 侧传递节点（声明 ^7.25.0），7.30.1 修复过多 content-encodings 未处理错误致 DoS'
  },
  {
    lockPath: 'node_modules/node-gyp/node_modules/undici',
    minVersion: '6.29.1',
    advisory: 'GHSA-xjj6-f33q-929c',
    reason: 'node-gyp 侧传递节点（声明 ^6.25.0），同通告的 6.x 修复版是 6.29.1'
  }
]

/**
 * 比较两个语义化版本：a > b 返回 1，a < b 返回 -1，相等返回 0。
 * 刻意不自研 range 解析、也不 import `semver`——后者只是传递依赖、未在 package.json 声明，
 * CI 的 `npm ci --ignore-scripts` 下形状不稳。
 * 预发布按保守序处理：同一三元组下，带预发布标签者小于不带者（如 4.6.6-beta < 4.6.6）。
 * 非 `X.Y.Z[-prerelease]` 形态一律抛错，避免脏数据被静默当成 0 比较。
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    if (pa.numbers[i] !== pb.numbers[i]) return pa.numbers[i] > pb.numbers[i] ? 1 : -1
  }
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

function parseSemver(input: string): {
  numbers: [number, number, number]
  prerelease: string | null
} {
  const matched = VERSION_PATTERN.exec(input)
  if (!matched) throw new Error(`不是合法的语义化版本（应为 X.Y.Z[-prerelease]）：${input}`)
  return {
    numbers: [Number(matched[1]), Number(matched[2]), Number(matched[3])],
    prerelease: matched[4] ?? null
  }
}

function comparePrerelease(a: string | null, b: string | null): number {
  if (a === b) return 0
  // 无预发布标签 = 正式版本，视为更大
  if (a === null) return 1
  if (b === null) return -1
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * 求值一组下限：返回违规描述列表（空数组即全部满足）。
 * 三类违规都要记账，且「节点不存在」不得退化成「跳过」——否则依赖树 dedupe 后本闸门变恒真。
 */
export function collectFloorViolations(
  packages: Record<string, LockPackageNode>,
  rows: readonly LockFloorRow[]
): string[] {
  const violations: string[] = []
  for (const row of rows) {
    const node = packages[row.lockPath]
    if (!node || typeof node.version !== 'string') {
      violations.push(
        `${row.lockPath} 在 lock 中不存在（${row.advisory} 的下限 ${row.minVersion} 无从判定）`
      )
      continue
    }
    if (compareSemver(node.version, row.minVersion) < 0) {
      violations.push(
        `${row.lockPath} 解析为 ${node.version}，低于 ${row.advisory} 的修复下限 ${row.minVersion}`
      )
    }
  }
  return violations
}

/** 互斥求值：同一通告「已按修复版落地」与「已豁免」不能并存，返回并存的通告列表。 */
export function collectMutexViolations(
  rows: readonly LockFloorRow[],
  allowlist: readonly string[]
): string[] {
  return rows.filter((row) => allowlist.includes(row.advisory)).map((row) => row.advisory)
}

function readLock(): Record<string, LockPackageNode> {
  const raw = readFileSync(new URL('package-lock.json', repoRootUrl), {
    encoding: 'utf-8',
    flag: 'r'
  })
  const lock = JSON.parse(raw) as LockFile
  if (!lock.packages)
    throw new Error('package-lock.json 缺少 packages 段（lockfileVersion 3 结构）')
  return lock.packages
}

/** 读 audit-ci.jsonc 的 allowlist：只剥行注释，够用且不引入 JSONC 依赖 */
function readAllowlist(): string[] {
  const raw = readFileSync(new URL('audit-ci.jsonc', repoRootUrl), { encoding: 'utf-8', flag: 'r' })
  const noComments = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  const config = JSON.parse(noComments) as { allowlist?: unknown }
  if (!Array.isArray(config.allowlist)) throw new Error('audit-ci.jsonc 的 allowlist 不是数组')
  return config.allowlist as string[]
}

describe('compareSemver（纯函数）', () => {
  it('正常：相等返回 0', () => {
    expect(compareSemver('4.6.6', '4.6.6')).toBe(0)
  })

  it('正常：主/次/修订三段按数值序比较', () => {
    expect(compareSemver('5.0.0', '4.9.9')).toBe(1)
    expect(compareSemver('4.7.0', '4.6.9')).toBe(1)
    expect(compareSemver('4.6.7', '4.6.6')).toBe(1)
    expect(compareSemver('4.6.5', '4.6.6')).toBe(-1)
    // 数值比较而非字典序：10 必须大于 9
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1)
  })

  it('正常：同三元组下预发布小于正式版', () => {
    expect(compareSemver('4.6.6-beta.1', '4.6.6')).toBe(-1)
    expect(compareSemver('4.6.6', '4.6.6-beta.1')).toBe(1)
  })

  it('异常：非法形态抛错（段数不足 / 非数字 / 空串）', () => {
    expect(() => compareSemver('4.6', '4.6.0')).toThrow('语义化版本')
    expect(() => compareSemver('v4.6.7', '4.6.6')).toThrow('语义化版本')
    expect(() => compareSemver('4.x.7', '4.6.6')).toThrow('语义化版本')
    expect(() => compareSemver('', '4.6.6')).toThrow('语义化版本')
  })
})

describe('collectFloorViolations / collectMutexViolations（纯函数）', () => {
  const rows: readonly LockFloorRow[] = [
    {
      lockPath: 'node_modules/demo',
      minVersion: '1.2.3',
      advisory: 'GHSA-aaaa-bbbb-cccc',
      reason: '合成用例'
    }
  ]

  it('正常：版本等于下限时不判违规（下限含等号）', () => {
    expect(collectFloorViolations({ 'node_modules/demo': { version: '1.2.3' } }, rows)).toEqual([])
  })

  it('异常：版本低于下限返回一条违规', () => {
    const violations = collectFloorViolations({ 'node_modules/demo': { version: '1.2.2' } }, rows)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('GHSA-aaaa-bbbb-cccc')
  })

  it('异常：节点不存在返回违规而不是静默跳过', () => {
    const violations = collectFloorViolations({ 'node_modules/other': { version: '9.9.9' } }, rows)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('不存在')
  })

  it('异常：节点存在但缺 version 字段同样判违规', () => {
    expect(collectFloorViolations({ 'node_modules/demo': {} }, rows)).toHaveLength(1)
  })

  it('异常：同一通告既落地又豁免时，互斥求值命中它', () => {
    expect(collectMutexViolations(rows, ['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff'])).toEqual([
      'GHSA-aaaa-bbbb-cccc'
    ])
  })

  it('边界：allowlist 为空时互斥求值无命中', () => {
    expect(collectMutexViolations(rows, [])).toEqual([])
  })
})

describe('表自身形状（边界）', () => {
  it('边界：行数在上限内且非空，防止长成第二份豁免清单', () => {
    expect(LOCK_FLOORS.length).toBeGreaterThan(0)
    expect(LOCK_FLOORS.length).toBeLessThanOrEqual(MAX_FLOOR_ROWS)
  })

  it('边界：lockPath 唯一、advisory 全部为合法 GHSA 编号', () => {
    const paths = LOCK_FLOORS.map((row) => row.lockPath)
    expect(new Set(paths).size).toBe(paths.length)
    for (const row of LOCK_FLOORS) {
      expect(row.advisory).toMatch(GHSA_PATTERN)
      expect(row.reason.trim().length).toBeGreaterThan(0)
      expect(compareSemver(row.minVersion, row.minVersion)).toBe(0)
    }
  })
})

describe('真实 package-lock.json（本轮红灯来源）', () => {
  const packages = readLock()

  it.each(LOCK_FLOORS)('$lockPath 在 lock 中存在', ({ lockPath }) => {
    expect(typeof packages[lockPath]?.version, `${lockPath} 应能在 packages 里取到 version`).toBe(
      'string'
    )
  })

  it.each(LOCK_FLOORS)(
    '$lockPath 解析版本不低于 $minVersion',
    ({ lockPath, minVersion, advisory }) => {
      const version = packages[lockPath]?.version as string
      expect(
        compareSemver(version, minVersion) >= 0,
        `${lockPath} 当前 ${version}，未达 ${advisory} 的修复下限 ${minVersion}`
      ).toBe(true)
    }
  )

  it('正常：互斥断言在真实数据上成立（表内通告不得同时躺在豁免清单里）', () => {
    expect(collectMutexViolations(LOCK_FLOORS, readAllowlist())).toEqual([])
  })
})
