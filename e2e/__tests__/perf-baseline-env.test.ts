/**
 * 性能基线「按运行环境分段」判定的守卫测试（docs/perf-regression.md §4）
 *
 * 要收口的缺陷：e2e/perf-baseline.json 是开发机录的相对基线，却被逐字套在 CI
 * （windows-latest）硬件上，比较对象与被测环境不一致 —— run 39623462678 的 step 10
 * 因此以 3 条相对回归判红（扫描入库 1900ms / 重复检测 6906ms / 重复检测吞吐量 217.2 项/秒），
 * 而同一份打包产物在开发机当日判定「✓ 全部通过」。
 *
 * 读数出处（全部为实测，不是构造）：
 * - CI 三份读数：run 39623462678 的 perf-results artifact 里两份 perf-run-*.json
 *   （retries=1 让 describe.serial 整链重跑一次）+ run 39772693608 的一份（绿运行只产一份），
 *   原始精度照抄；ci 段就是这三份的中位数，status=final、sampleCount=3
 * - 开发机读数：本机 .cache/perf/latest.json（2026-10-21T15:22:20.971Z）
 * 这些数值以字面量固化在本文件里：.cache/ 是 gitignore 的，CI 上读不到，
 * 且「解析型读数必须配字面量断言」，否则守卫自己坏掉时也会通过。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_HARD_RULES,
  evaluateSamples,
  loadBaseline,
  parseBaseline,
  resolvePerfEnv,
  type PerfBaseline,
  type PerfSample
} from '../perf-helpers'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 按 id 赋值的采样构造器（scenario 文案与 e2e/perf.e2e.ts 产出的真实报告一致） */
const SCENARIOS: Record<string, string> = {
  'cold-start-first-paint': '冷启动（启动+建库+首屏）',
  'scan-ingest': '扫描入库（1500 张）',
  'scan-throughput': '扫描吞吐量',
  'media-list-page100': '媒体列表加载（首页 100 条）',
  'media-list-page500': '媒体列表加载（大页 500 条）',
  'find-duplicates': '重复文件检测（1500 个文件）',
  'find-duplicates-throughput': '重复检测吞吐量',
  'cache-get-stats': '缓存统计查询',
  'thumbnail-generate-p50': '缩略图按需生成 P50',
  'thumbnail-generate-p95': '缩略图按需生成 P95',
  'first-thumbnail-visible': '首图显影耗时（重新进入图库）'
}

const THROUGHPUT_IDS = new Set(['scan-throughput', 'find-duplicates-throughput'])

function samples(values: Record<string, number>): PerfSample[] {
  return Object.entries(values).map(([id, value]) => ({
    id,
    scenario: SCENARIOS[id] ?? id,
    value,
    unit: THROUGHPUT_IDS.has(id) ? ('items/sec' as const) : ('ms' as const)
  }))
}

/** run 39623462678 第一次测量（perf-run-2026-10-21T15-21-17-943Z.json） */
const CI_PASS_1: Record<string, number> = {
  'cold-start-first-paint': 1692.9402000000002,
  'scan-ingest': 1945.9097999999994,
  'scan-throughput': 770.85,
  'media-list-page100': 11.100000000093132,
  'media-list-page500': 29.599999999976717,
  'find-duplicates': 5642.372000000001,
  'find-duplicates-throughput': 265.85,
  'cache-get-stats': 1.7000000000698492,
  'thumbnail-generate-p50': 3.099999999976717,
  'thumbnail-generate-p95': 5.400000000023283,
  'first-thumbnail-visible': 513.4358999999986
}

/** run 39623462678 第二次测量（perf-run-2026-10-21T15-21-36-367Z.json，即 latest.json） */
const CI_PASS_2: Record<string, number> = {
  'cold-start-first-paint': 1839.7084,
  'scan-ingest': 1900.3671999999997,
  'scan-throughput': 789.32,
  'media-list-page100': 12.400000000023283,
  'media-list-page500': 22.699999999953434,
  'find-duplicates': 6906.1963000000005,
  'find-duplicates-throughput': 217.2,
  'cache-get-stats': 2.3999999999068677,
  'thumbnail-generate-p50': 5.099999999976717,
  'thumbnail-generate-p95': 27.099999999976717,
  'first-thumbnail-visible': 865.0233000000007
}

/** run 39772693608（提交 e5a4bff 那次绿运行）= 第三份样本，也是 ci 段转 final 的依据 */
const CI_PASS_3: Record<string, number> = {
  'cold-start-first-paint': 1692.1242000000002,
  'scan-ingest': 1721.5451999999996,
  'scan-throughput': 871.31,
  'media-list-page100': 22.599999999976717,
  'media-list-page500': 20,
  'find-duplicates': 5689.250999999999,
  'find-duplicates-throughput': 263.66,
  'cache-get-stats': 1.7999999999883585,
  'thumbnail-generate-p50': 3,
  'thumbnail-generate-p95': 5.7000000000116415,
  'first-thumbnail-visible': 343.5684000000001
}

/** 开发机 2026-10-21 复跑同一份产物的读数（.cache/perf/latest.json，判定为全部通过） */
const DEV_TODAY: Record<string, number> = {
  'cold-start-first-paint': 908.6333,
  'scan-ingest': 635.9343000000001,
  'scan-throughput': 2358.73,
  'media-list-page100': 13.100000001490116,
  'media-list-page500': 7.800000000745058,
  'find-duplicates': 1122.2421,
  'find-duplicates-throughput': 1336.61,
  'cache-get-stats': 0.4000000022351742,
  'thumbnail-generate-p50': 1,
  'thumbnail-generate-p95': 1.699999999254942,
  'first-thumbnail-visible': 105.22499999999991
}

/** v1 基线的完整快照（2026-08-23 开发机固化）——本轮改造的等价性基准，逐字固化在此 */
const V1_SNAPSHOT = {
  'cold-start-first-paint': { maxMs: 15000, baselineValue: 2106.52, regressionFactor: 3 },
  'scan-ingest': { maxMs: 30000, baselineValue: 414.29, regressionFactor: 3 },
  'scan-throughput': { minThroughput: 150, baselineValue: 3620.64, regressionFactor: 5 },
  'media-list-page100': { maxMs: 1000, baselineValue: 7.8, regressionFactor: 10 },
  'media-list-page500': { maxMs: 1000, baselineValue: 10.3, regressionFactor: 10 },
  'find-duplicates': { maxMs: 60000, baselineValue: 1010.27, regressionFactor: 3 },
  'find-duplicates-throughput': { minThroughput: 100, baselineValue: 1484.75, regressionFactor: 3 },
  'cache-get-stats': { maxMs: 1000, baselineValue: 0.7, regressionFactor: 50 }
} as const

/** ci 段 = 三份真 CI 读数的中位数，factor 逐项照搬 dev 段（分段只换比较对象，不换容忍系数） */
const CI_FINAL: Record<string, { baselineValue: number; regressionFactor: number }> = {
  'cold-start-first-paint': { baselineValue: 1692.94, regressionFactor: 3 },
  'scan-ingest': { baselineValue: 1900.37, regressionFactor: 3 },
  'scan-throughput': { baselineValue: 789.32, regressionFactor: 5 },
  'media-list-page100': { baselineValue: 12.4, regressionFactor: 10 },
  'media-list-page500': { baselineValue: 22.7, regressionFactor: 10 },
  'find-duplicates': { baselineValue: 5689.25, regressionFactor: 3 },
  'find-duplicates-throughput': { baselineValue: 263.66, regressionFactor: 3 },
  'cache-get-stats': { baselineValue: 1.8, regressionFactor: 50 }
}

const CI_SOURCE_RUNS = [
  '39623462678#perf-run-2026-10-21T15-21-17-943Z',
  '39623462678#perf-run-2026-10-21T15-21-36-367Z',
  '39772693608#perf-run-2026-10-22T11-52-52-331Z'
]

async function realBaseline(): Promise<PerfBaseline> {
  const baseline = await loadBaseline()
  expect(baseline, '基线文件必须能解析为 v2（返回 null 表示已降级为仅绝对阈值判定）').not.toBeNull()
  return baseline as PerfBaseline
}

describe('环境键判定 resolvePerfEnv', () => {
  it('PERF_ENV 显式覆盖优先于一切宿主信号', () => {
    expect(resolvePerfEnv({ PERF_ENV: 'dev', GITHUB_ACTIONS: 'true' })).toBe('dev')
    expect(resolvePerfEnv({ PERF_ENV: 'ci' })).toBe('ci')
    expect(resolvePerfEnv({ PERF_ENV: 'CI', GITHUB_ACTIONS: 'true' })).toBe('ci')
  })
  it('GitHub Actions 宿主信号判为 ci', () => {
    expect(resolvePerfEnv({ GITHUB_ACTIONS: 'true' })).toBe('ci')
    expect(resolvePerfEnv({ RUNNER_ENVIRONMENT: 'github-hosted' })).toBe('ci')
  })
  it('裸 CI=true 不足以选 ci 段：开发机 shell/IDE 也可能带它，选错段等于换比较口径', () => {
    expect(resolvePerfEnv({ CI: 'true' })).toBe('dev')
    expect(resolvePerfEnv({})).toBe('dev')
    expect(resolvePerfEnv({ GITHUB_ACTIONS: 'false', CI: 'true' })).toBe('dev')
  })
  it('PERF_ENV 非法值忽略，退回宿主信号判定', () => {
    expect(resolvePerfEnv({ PERF_ENV: 'staging', GITHUB_ACTIONS: 'true' })).toBe('ci')
    expect(resolvePerfEnv({ PERF_ENV: 'staging' })).toBe('dev')
  })
})

describe('基线 v2 结构（绝对护栏全局共享 + 相对基线按环境分段）', () => {
  it('正常：真实基线为 v2，dev 段绝对护栏与相对值逐字等于 v1 快照（开发机判定不得漂移）', async () => {
    const baseline = await realBaseline()
    expect(baseline.version).toBe(2)
    expect(baseline.datasetImages).toBe(1500)
    for (const [id, v1] of Object.entries(V1_SNAPSHOT)) {
      const hard = 'maxMs' in v1 ? { maxMs: v1.maxMs } : { minThroughput: v1.minThroughput }
      expect(baseline.hardRules[id], `hardRules[${id}] 与 v1 不一致`).toEqual(hard)
      expect(baseline.environments.dev?.metrics[id], `dev 段 ${id} 与 v1 不一致`).toEqual({
        baselineValue: v1.baselineValue,
        regressionFactor: v1.regressionFactor
      })
    }
  })
  it('边界：v1 里没有条目的指标继续落 DEFAULT_HARD_RULES，不得被顺手搬进 hardRules', async () => {
    const baseline = await realBaseline()
    expect(Object.keys(baseline.hardRules).sort()).toEqual(Object.keys(V1_SNAPSHOT).sort())
    for (const id of ['thumbnail-generate-p95', 'first-thumbnail-visible']) {
      expect(baseline.hardRules[id]).toBeUndefined()
      expect(DEFAULT_HARD_RULES[id]).toBeDefined()
    }
  })
  it('边界：ci 段每项 regressionFactor 必须逐项等于 dev 段（禁止给 CI 放宽系数）', async () => {
    const baseline = await realBaseline()
    const dev = baseline.environments.dev?.metrics ?? {}
    const ci = baseline.environments.ci?.metrics ?? {}
    expect(Object.keys(ci).sort()).toEqual(Object.keys(dev).sort())
    for (const id of Object.keys(ci)) {
      expect(ci[id].regressionFactor, `ci 段 ${id} 的系数与 dev 段不一致`).toBe(
        dev[id].regressionFactor
      )
    }
  })
  it('边界：ci 段等于三份 CI 读数的中位数，final 且带三条可追溯来源', async () => {
    const baseline = await realBaseline()
    const ci = baseline.environments.ci
    expect(ci?.metrics).toEqual(CI_FINAL)
    expect(ci?.status).toBe('final')
    expect(ci?.sampleCount).toBe(3)
    expect(ci?.sourceRuns).toEqual(CI_SOURCE_RUNS)
    expect(ci?.environment).toContain('windows-latest')
  })
  it('异常：version 非 2 / 缺 environments / sourceRuns 为空 一律判为结构不合', () => {
    expect(() => parseBaseline(JSON.stringify({ version: 1, metrics: {} }))).toThrowError(/version/)
    expect(() =>
      parseBaseline(JSON.stringify({ version: 2, datasetImages: 1500, hardRules: {} }))
    ).toThrowError(/environments/)
    expect(() =>
      parseBaseline(
        JSON.stringify({
          version: 2,
          datasetImages: 1500,
          hardRules: {},
          environments: {
            ci: {
              recordedAt: 'x',
              environment: 'y',
              status: 'final',
              sampleCount: 1,
              sourceRuns: [],
              metrics: {}
            }
          }
        })
      )
    ).toThrowError(/sourceRuns/)
  })
  it('边界：带 BOM 的 v2 仍可解析（外部工具写回不得让判定静默降级）', () => {
    const raw = readFileSync(path.join(ROOT_DIR, 'e2e', 'perf-baseline.json'), 'utf-8')
    const parsed = parseBaseline(`\uFEFF${raw}`)
    expect(parsed.version).toBe(2)
  })
})

describe('evaluateSamples 按环境选段', () => {
  it('正常：三份 CI 读数选 ci 段均 0 违规（本轮缺陷的正向复现 + 基线幂等）', async () => {
    const baseline = await realBaseline()
    expect(evaluateSamples(samples(CI_PASS_1), baseline, 'ci')).toEqual([])
    expect(evaluateSamples(samples(CI_PASS_2), baseline, 'ci')).toEqual([])
    expect(evaluateSamples(samples(CI_PASS_3), baseline, 'ci')).toEqual([])
  })
  it('反向：同批 CI 读数选 dev 段恰命中 run 39623462678 的三条回归', async () => {
    const baseline = await realBaseline()
    const violations = evaluateSamples(samples(CI_PASS_2), baseline, 'dev')
    expect(violations.map((v) => [v.kind, v.metricId])).toEqual([
      ['regression', 'scan-ingest'],
      ['regression', 'find-duplicates'],
      ['regression', 'find-duplicates-throughput']
    ])
  })
  it('正常：开发机读数选 dev 段 0 违规（改造后与今天等价，未放宽也未收紧）', async () => {
    const baseline = await realBaseline()
    expect(evaluateSamples(samples(DEV_TODAY), baseline, 'dev')).toEqual([])
  })
  it('异常：所选环境段缺失 ⇒ 判一条 missing_section，而不是静默只跑硬护栏', async () => {
    const baseline = await realBaseline()
    const withoutCi: PerfBaseline = {
      ...baseline,
      environments: { dev: baseline.environments.dev }
    }
    const violations = evaluateSamples(samples(CI_PASS_2), withoutCi, 'ci')
    expect(violations.map((v) => [v.kind, v.metricId])).toEqual([
      ['missing_section', '(env-section)']
    ])
    // 同一份基线选 dev 段仍应 0 违规：证明只是段缺失，不是判定整体停摆
    expect(evaluateSamples(samples(CI_PASS_2), withoutCi, 'dev')).toHaveLength(3)
  })
  it('边界：provisional 段照常参与相对判定（播种不等于关闭判定）', async () => {
    const baseline = await realBaseline()
    // 不依赖入库基线当前是 provisional 还是 final：状态语义由判定逻辑保证，故构造一份 provisional 段
    const provisional: PerfBaseline = {
      ...baseline,
      environments: {
        ...baseline.environments,
        ci: { ...baseline.environments.ci!, status: 'provisional' }
      }
    }
    const over = { ...CI_PASS_3, 'scan-ingest': 1900.37 * 3 + 1 }
    const violations = evaluateSamples(samples(over), provisional, 'ci')
    expect(violations.map((v) => [v.kind, v.metricId])).toEqual([['regression', 'scan-ingest']])
  })
  it('边界：绝对护栏与环境段无关，两个环境都必须满足', async () => {
    const baseline = await realBaseline()
    const slow = { ...CI_PASS_2, 'scan-ingest': 30001 }
    for (const envKey of ['dev', 'ci'] as const) {
      const kinds = evaluateSamples(samples(slow), baseline, envKey).map((v) => v.kind)
      expect(kinds, `${envKey} 段应判出绝对阈值超限`).toContain('threshold')
    }
  })
})

describe('ci 段固化状态与技术债条目双向耦合', () => {
  it('契约：provisional ⇒ DEBT-037 open；final ⇒ DEBT-037 done', async () => {
    const baseline = await realBaseline()
    const registry = JSON.parse(
      readFileSync(path.join(ROOT_DIR, 'docs', 'debt-registry.json'), 'utf-8')
    ) as { items: { id: string; status: string }[] }
    const debt = registry.items.find((i) => i.id === 'DEBT-037')
    const status = baseline.environments.ci?.status
    if (status === 'provisional') {
      expect(debt?.status, 'ci 段未固化期间 DEBT-037 必须是 open').toBe('open')
    } else {
      expect(status, `ci 段 status 只能是 provisional|final，实际 ${status}`).toBe('final')
      expect(debt?.status, 'ci 段固化为 final 后 DEBT-037 必须收口为 done').toBe('done')
    }
  })
})
