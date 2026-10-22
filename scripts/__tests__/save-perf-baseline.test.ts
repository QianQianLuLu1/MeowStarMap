/**
 * 性能基线固化脚本的纯函数单测（scripts/perf-test/save-perf-baseline.ts）
 *
 * 要钉住的行为：v2 基线按环境分段后，固化只允许改写所选段，
 * 绝对护栏（hardRules）与另一环境段必须原样保留；ci 段样本不足时不得伪装成已固化。
 * 全部用例只喂内存对象，不触磁盘（照 scripts/__tests__/verify-nikkisync-link.test.ts 口径）。
 */
import { describe, it, expect } from 'vitest'
import {
  MIN_CI_SAMPLES,
  aggregateSamples,
  mergeBaselineSection,
  parseSamplesArg,
  planSection,
  resolveEnvKey,
  type PerfBaselineLike,
  type RunReportLike
} from '../perf-test/save-perf-baseline'

function report(timestamp: string, values: Record<string, number>): RunReportLike {
  return {
    timestamp,
    platform: 'win32-x64',
    nodeVersion: 'v22.23.3',
    perfEnv: 'ci',
    datasetImages: 1500,
    samples: Object.entries(values).map(([id, value]) => ({
      id,
      scenario: id,
      value,
      unit: id.endsWith('-throughput') ? ('items/sec' as const) : ('ms' as const)
    })),
    violations: [],
    passed: true
  }
}

const BASELINE: PerfBaselineLike = {
  version: 2,
  datasetImages: 1500,
  hardRules: { 'scan-ingest': { maxMs: 30000 } },
  environments: {
    dev: {
      recordedAt: '2026-08-23T14:59:05.625Z',
      environment: 'win32-x64（本地开发机实测）',
      status: 'final',
      sampleCount: 1,
      sourceRuns: ['perf-run-2026-08-23T14-59-05-625Z'],
      metrics: { 'scan-ingest': { baselineValue: 414.29, regressionFactor: 3 } }
    },
    ci: {
      recordedAt: '2026-10-21T15:21:36.367Z',
      environment: 'windows-latest（GitHub Actions）',
      status: 'provisional',
      sampleCount: 2,
      sourceRuns: ['39623462678#a', '39623462678#b'],
      metrics: { 'scan-ingest': { baselineValue: 1923.14, regressionFactor: 3 } }
    }
  }
}

describe('resolveEnvKey 参数校验', () => {
  it('正常：--env 空格形式与等号形式都接受', () => {
    expect(resolveEnvKey(['--env', 'ci'], {})).toBe('ci')
    expect(resolveEnvKey(['--env=dev'], {})).toBe('dev')
  })
  it('正常：缺省时按宿主信号判定，PERF_ENV 优先', () => {
    expect(resolveEnvKey([], { GITHUB_ACTIONS: 'true' })).toBe('ci')
    expect(resolveEnvKey([], { PERF_ENV: 'dev', GITHUB_ACTIONS: 'true' })).toBe('dev')
    expect(resolveEnvKey([], {})).toBe('dev')
  })
  it('异常：非法值直接拒绝，不静默退回默认段', () => {
    expect(() => resolveEnvKey(['--env', 'staging'], {})).toThrowError(/dev/)
    expect(() => resolveEnvKey(['--env'], {})).toThrowError()
  })
})

describe('parseSamplesArg 参数校验', () => {
  it('正常：收集 --samples 后面、下一个选项前的全部路径', () => {
    expect(parseSamplesArg(['--samples', 'a.json', 'b.json', '--env', 'ci'])).toEqual([
      'a.json',
      'b.json'
    ])
  })
  it('边界：未给 --samples 时返回空数组（调用方退回 latest.json 单文件）', () => {
    expect(parseSamplesArg([])).toEqual([])
  })
  it('异常：--samples 后面没有任何路径即报错', () => {
    expect(() => parseSamplesArg(['--samples'])).toThrowError()
    expect(() => parseSamplesArg(['--samples', '--env', 'ci'])).toThrowError()
  })
})

describe('aggregateSamples 多样聚合', () => {
  it('正常：两份报告取中位数（偶数取中间两项平均）', () => {
    const agg = aggregateSamples([
      report('2026-10-21T15:21:17.943Z', { 'scan-ingest': 1945.9098, 'scan-throughput': 770.85 }),
      report('2026-10-21T15:21:36.367Z', { 'scan-ingest': 1900.3672, 'scan-throughput': 789.32 })
    ])
    expect(agg.get('scan-ingest')).toEqual({
      value: 1923.1385,
      count: 2,
      unit: 'ms',
      lastTimestamp: '2026-10-21T15:21:36.367Z'
    })
    expect(agg.get('scan-throughput')?.unit).toBe('items/sec')
  })
  it('正常：三份报告取真正的中位数，不受极端值拉动', () => {
    const agg = aggregateSamples([
      report('t1', { 'find-duplicates': 5642.372 }),
      report('t2', { 'find-duplicates': 6906.1963 }),
      report('t3', { 'find-duplicates': 6500 })
    ])
    expect(agg.get('find-duplicates')?.value).toBe(6500)
    expect(agg.get('find-duplicates')?.count).toBe(3)
  })
  it('边界：指标 id 不一致时按并集聚合，并如实记录每个 id 的样本数', () => {
    const agg = aggregateSamples([
      report('t1', { 'scan-ingest': 100 }),
      report('t2', { 'cache-get-stats': 2 })
    ])
    expect(agg.get('scan-ingest')).toMatchObject({ value: 100, count: 1 })
    expect(agg.get('cache-get-stats')).toMatchObject({ value: 2, count: 1 })
  })
  it('异常：空报告数组直接拒绝（否则会把基线写成空段）', () => {
    expect(() => aggregateSamples([])).toThrowError()
  })
})

describe('planSection 分段固化规则', () => {
  const agg2 = aggregateSamples([
    report('2026-10-21T15:21:17.943Z', { 'scan-ingest': 1945.9098 }),
    report('2026-10-21T15:21:36.367Z', { 'scan-ingest': 1900.3672 })
  ])

  it('边界：ci 段样本数 < MIN_CI_SAMPLES ⇒ provisional 并给出待补样告警', () => {
    const { section, warnings } = planSection({
      envKey: 'ci',
      aggregate: agg2,
      existing: BASELINE,
      sourceRuns: ['a', 'b'],
      requireFinal: false
    })
    expect(MIN_CI_SAMPLES).toBe(3)
    expect(section.status).toBe('provisional')
    expect(section.sampleCount).toBe(2)
    expect(warnings.join('\n')).toContain('待补样')
  })
  it('正常：ci 段样本数达标 ⇒ final，且 baselineValue 保留两位小数', () => {
    const agg3 = aggregateSamples([
      ...[agg2].map(() => report('t1', { 'scan-ingest': 1945.9098 })),
      report('t2', { 'scan-ingest': 1900.3672 }),
      report('t3', { 'scan-ingest': 1900.3672 })
    ])
    const { section } = planSection({
      envKey: 'ci',
      aggregate: agg3,
      existing: BASELINE,
      sourceRuns: ['a', 'b', 'c'],
      requireFinal: false
    })
    expect(section.status).toBe('final')
    expect(section.sampleCount).toBe(3)
    expect(section.metrics['scan-ingest'].baselineValue).toBe(1900.37)
    expect(section.metrics['scan-ingest'].regressionFactor).toBe(3)
    expect(section.sourceRuns).toEqual(['a', 'b', 'c'])
  })
  it('异常：样本不足却显式要求 final ⇒ 拒绝，不静默降级', () => {
    expect(() =>
      planSection({
        envKey: 'ci',
        aggregate: agg2,
        existing: BASELINE,
        sourceRuns: ['a', 'b'],
        requireFinal: true
      })
    ).toThrowError(/3/)
  })
  it('正常：dev 段允许单样本直接固化（本机实测就是基线来源）', () => {
    const { section } = planSection({
      envKey: 'dev',
      aggregate: aggregateSamples([report('t1', { 'scan-ingest': 636 })]),
      existing: BASELINE,
      sourceRuns: ['dev-run'],
      requireFinal: false
    })
    expect(section.status).toBe('final')
    expect(section.sampleCount).toBe(1)
  })
  it('边界：沿用该段已有的 environment 描述，不被 platform 串覆盖', () => {
    const { section } = planSection({
      envKey: 'ci',
      aggregate: agg2,
      existing: BASELINE,
      sourceRuns: ['a', 'b'],
      requireFinal: false
    })
    expect(section.environment).toBe('windows-latest（GitHub Actions）')
  })
  it('异常：只携带受门禁指标集，不得给观察项凭空造出相对规则', () => {
    // dev 段只定义了 scan-ingest；报告里还有观察项 thumbnail-generate-p50。
    // 若照单全收，观察项会拿到缺省 factor 2 的新门禁（docs/perf-regression.md §6 明确 P50/P95
    // 只作观察或仅受硬护栏），CI 上必然制造假红——实测 p95 两次读数为 5.4ms 与 27.1ms。
    const { section, warnings } = planSection({
      envKey: 'ci',
      aggregate: aggregateSamples([
        report('t1', { 'scan-ingest': 1900, 'thumbnail-generate-p50': 3.1 }),
        report('t2', { 'scan-ingest': 1950, 'thumbnail-generate-p50': 5.1 }),
        report('t3', { 'scan-ingest': 1920, 'thumbnail-generate-p50': 3.1 })
      ]),
      existing: BASELINE,
      sourceRuns: ['a', 'b', 'c'],
      requireFinal: false
    })
    expect(Object.keys(section.metrics)).toEqual(['scan-ingest'])
    expect(warnings.join('\n')).toContain('thumbnail-generate-p50')
  })
  it('边界：基线还不存在时（首次固化）没有既有指标集可约束，按实测全量建段', () => {
    const { section } = planSection({
      envKey: 'dev',
      aggregate: aggregateSamples([
        report('t1', { 'scan-ingest': 636, 'thumbnail-generate-p50': 1 })
      ]),
      existing: null,
      sourceRuns: ['first'],
      requireFinal: false
    })
    expect(Object.keys(section.metrics).sort()).toEqual(['scan-ingest', 'thumbnail-generate-p50'])
  })
})

describe('mergeBaselineSection 只改写所选段', () => {
  const section = planSection({
    envKey: 'ci',
    aggregate: aggregateSamples([report('t1', { 'scan-ingest': 1900 })]),
    existing: BASELINE,
    sourceRuns: ['x'],
    requireFinal: false
  }).section

  it('正常：hardRules 与另一段逐字不动，version/datasetImages 保持', () => {
    const next = mergeBaselineSection(BASELINE, 'ci', section)
    expect(next.hardRules).toEqual(BASELINE.hardRules)
    expect(next.environments.dev).toEqual(BASELINE.environments.dev)
    expect(next.version).toBe(2)
    expect(next.datasetImages).toBe(1500)
    expect(next.environments.ci).toEqual(section)
  })
  it('异常：入参基线不是 v2 时拒绝写入（不做静默迁移）', () => {
    expect(() =>
      mergeBaselineSection(
        { version: 1, metrics: {} } as unknown as PerfBaselineLike,
        'ci',
        section
      )
    ).toThrowError(/version/)
  })
})
