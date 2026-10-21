import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * e2e 超时预算守卫：任何一条显式等待都必须落在该用例的有效预算之内。
 *
 * 要收口的真实事故（run 39583778122，CI 唯一红点）：
 * `e2e/fullscreen-diagnose.e2e.ts` 在 60s 的单用例预算里 `waitForSelector('[role="grid"]',
 * { timeout: 90_000 })`。CI 的 windows runner 上没有游戏 ⇒ `findMediaDirectories` 找到 0 个目录
 * ⇒ 图库走 `GalleryPage.tsx` 的 EmptyState 分支 ⇒ `[role="grid"]` 永不出现在 DOM 里。
 * 于是用例在 await 里就被 Playwright 判 `Test timeout of 60000ms exceeded`，
 * 紧随其后的 `catch` 兜底与末尾断言**根本不会执行**——该文件末尾两条断言是 `||` 恒真式，
 * 恒真只能保证「不因断言判红」，救不了「因超时判红」。日志读数：
 * `1 failed / 6 skipped / 8 passed (2.2m)`，失败两次各 `(1.0m)`，步骤耗时 134s。
 *
 * 判据形态：按文件级粗粒度（同文件内最大的 test.setTimeout 抬升整文件预算）。
 * 刻意不做逐用例块解析——那需要一个 JS 词法器，收益不抵复杂度；代价是同文件里
 * 一条大预算用例会给其他用例放行，因此覆盖面清单与「等待必须小于预算」这条硬判据
 * 一起钉住，新增用例仍会被逐条读数暴露。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const e2eDir = path.join(repoRoot, 'e2e')

/**
 * launch + firstWindow + 一次 domcontentloaded 的最短成本预留：
 * helpers.ts 的 launch 上限 30s、探针/smoke 的 domcontentloaded 各 15s。
 * 等待值必须留出这段余量，否则「等待跑满」与「用例被杀」之间没有可区分空间。
 */
const SETUP_MARGIN_MS = 15_000

/** `npm run e2e:smoke` = `--grep-invert @perf`，故含 @perf 的文件不进冒烟覆盖面 */
const SMOKE_COVERAGE = ['fullscreen-diagnose.e2e.ts', 'nikkisync-runtime.e2e.ts', 'smoke.e2e.ts']

export interface BudgetViolation {
  /** 违例的等待毫秒数；符号量（读不出字面量）时为 null */
  waitMs: number | null
  budgetMs: number
  /** true ⇒ test.setTimeout 的参数不是数字字面量，守卫拒绝放行 */
  unresolved: boolean
}

/** 只认 `[0-9_]+` 字面量；符号/表达式返回 null（调用方必须据此判违例，不得跳过） */
export function parseMs(token: string): number | null {
  return /^[\d_]+$/.test(token) ? Number(token.replace(/_/g, '')) : null
}

/**
 * 读 playwright 配置的超时口径。
 * 顶层 `timeout` 必须恰好一条：多解/无解一律抛错，防止「重排版把值藏起来」
 * 让预算被静默放宽（那正是本守卫要防的那类漂移）。
 */
export function readConfigTimeouts(configSrc: string): {
  testTimeout: number
  expectTimeout: number
} {
  const topLevel = configSrc
    .split(/\r?\n/)
    .filter((l) => /^ {2}timeout:/.test(l))
    .map((l) =>
      l
        .replace(/^ {2}timeout:\s*/, '')
        .replace(/[,;]\s*$/, '')
        .trim()
    )
  if (topLevel.length !== 1) {
    throw new Error(`单用例预算必须恰好一条顶层 timeout（实际 ${topLevel.length} 条）`)
  }
  const testTimeout = parseMs(topLevel[0])
  if (testTimeout === null) {
    throw new Error(`顶层 timeout 必须是数字字面量（实际 ${topLevel[0]}），符号量会让预算不可判`)
  }
  const expectBlock = /expect:\s*\{\s*timeout:\s*([\d_]+)/.exec(configSrc)
  if (!expectBlock) {
    throw new Error('未找到 expect.timeout 声明，配置形态已漂移')
  }
  return { testTimeout, expectTimeout: Number(expectBlock[1].replace(/_/g, '')) }
}

/** 扫一个用例文件里的显式等待，返回所有超出有效预算的项 */
export function findOverBudgetWaits(
  src: string,
  configBudgetMs: number,
  marginMs: number = SETUP_MARGIN_MS
): BudgetViolation[] {
  const setTimeoutLiterals: number[] = []
  let unresolvedBudget = false
  for (const m of src.matchAll(/test\.setTimeout\(\s*([^)]*?)\s*\)/g)) {
    const v = parseMs(m[1])
    if (v === null) unresolvedBudget = true
    else setTimeoutLiterals.push(v)
  }
  const budgetMs = Math.max(configBudgetMs, ...setTimeoutLiterals)
  const violations: BudgetViolation[] = []
  if (unresolvedBudget) {
    // 把预算数字挪进变量会绕过本守卫，因此直接判违例，逼着写回字面量
    violations.push({ waitMs: null, budgetMs, unresolved: true })
  }
  for (const m of src.matchAll(/\btimeout:\s*([\d_]+)/g)) {
    const waitMs = parseMs(m[1])
    if (waitMs === null) {
      violations.push({ waitMs: null, budgetMs, unresolved: true })
      continue
    }
    // timeout: 0 在 Playwright 语义里是「不限时」，属最危险形态，一律判违例
    if (waitMs === 0 || waitMs > budgetMs - marginMs) {
      violations.push({ waitMs, budgetMs, unresolved: false })
    }
  }
  return violations
}

/** 冒烟覆盖面内的真实用例文件清单（不含 @perf，不含本目录的 *.test.ts） */
export function smokeCoveredFiles(dirListing: string[]): string[] {
  return dirListing
    .filter((f) => f.endsWith('.e2e.ts'))
    .filter((f) => !readFileSync(path.join(e2eDir, f), 'utf-8').includes('@perf'))
    .sort()
}

describe('e2e 超时预算：显式等待不得超过用例预算', () => {
  it('正常：补了 test.setTimeout 的 90s 等待合规', () => {
    const src =
      "test('t', async () => {\n  test.setTimeout(150_000)\n" +
      '  await w.waitForSelector(\'[role="grid"]\', { timeout: 90_000 })\n})\n'
    expect(findOverBudgetWaits(src, 60_000)).toEqual([])
  })

  it('正常：等待缩到 45s 且不补预算也合规（判据不只认 setTimeout）', () => {
    const src = "test('t', async () => {\n  await w.waitForSelector('x', { timeout: 45_000 })\n})\n"
    expect(findOverBudgetWaits(src, 60_000)).toEqual([])
  })

  it('异常：HEAD 原样形状（90s 等待 + 无预算）必须判出恰好一条违例', () => {
    const src =
      "test('t', async () => {\n  await w.waitForSelector('[role=\"grid\"]', { timeout: 90_000 })\n})\n"
    const v = findOverBudgetWaits(src, 60_000)
    expect(v).toEqual([{ waitMs: 90_000, budgetMs: 60_000, unresolved: false }])
  })

  it('异常：把预算写成变量（符号量）不得绕过守卫', () => {
    const src =
      "test('t', async () => {\n  test.setTimeout(BUDGET_MS)\n" +
      "  await w.waitForSelector('x', { timeout: 90_000 })\n})\n"
    const v = findOverBudgetWaits(src, 60_000)
    expect(v.some((x) => x.unresolved)).toBe(true)
  })

  it('边界：timeout: 0（Playwright 语义为不限时）判违例', () => {
    const v = findOverBudgetWaits(
      "test('t', async () => {\n  await w.waitFor('x', { timeout: 0 })\n})\n",
      60_000
    )
    expect(v).toEqual([{ waitMs: 0, budgetMs: 60_000, unresolved: false }])
  })

  it('边界：配置里出现两条顶层 timeout ⇒ 抛错而非猜默认值', () => {
    const bad =
      'export default {\n  timeout: 60_000\n  timeout: 300_000\n  expect: {\n    timeout: 15_000\n  }\n}\n'
    expect(() => readConfigTimeouts(bad)).toThrow(/恰好一条/)
    const indented =
      'export default {\n    timeout: 60_000\n  expect: {\n    timeout: 15_000\n  }\n}\n'
    expect(() => readConfigTimeouts(indented)).toThrow(/恰好一条/)
  })

  it('配置读数不得漂移（期望值写死字面量，绝不从被解析文件反推）', () => {
    const cfg = readFileSync(path.join(e2eDir, 'playwright.config.ts'), 'utf-8')
    expect(readConfigTimeouts(cfg)).toEqual({ testTimeout: 60_000, expectTimeout: 15_000 })
  })

  it('覆盖面：冒烟只跑这三个文件（探针被改名/删除即在此暴露）', () => {
    expect(smokeCoveredFiles(readdirSync(e2eDir))).toEqual(SMOKE_COVERAGE)
  })

  it('真实契约：冒烟覆盖面内不得存在超出预算的等待', () => {
    const cfg = readFileSync(path.join(e2eDir, 'playwright.config.ts'), 'utf-8')
    const { testTimeout } = readConfigTimeouts(cfg)
    const offenders: string[] = []
    for (const f of smokeCoveredFiles(readdirSync(e2eDir))) {
      const src = readFileSync(path.join(e2eDir, f), 'utf-8')
      for (const v of findOverBudgetWaits(src, testTimeout)) {
        offenders.push(`${f}: wait=${v.waitMs ?? '符号量'} budget=${v.budgetMs}`)
      }
    }
    expect(
      offenders,
      `以下等待超出用例预算，会被 Playwright 在 await 里直接判 timeout 失败，` +
        `其后的兜底 catch 与断言永远执行不到：\n${offenders.join('\n')}`
    ).toEqual([])
  })
})
