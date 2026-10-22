/**
 * 性能读数注解脚本的守卫测试（scripts/perf-test/emit-perf-readings.ts）
 *
 * 为什么需要它：本机没有 token，artifact 下载与 step 日志正文都是 401/404，
 * 而 CI 采样读数必须回流多次才能固化 ci 段基线。GitHub 的 check-run annotations
 * 是**免鉴权可读**的（见 docs/plans/2026-10-22-perf-baseline-env-split.md §5），
 * 所以把读数打成一行 ::notice:: 注解，就能零 token 取数。
 * 该通道必须在 step 判红时也能出数 ⇒ build.yml 那一步必须 if: always()。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  buildPerfReadingsAnnotation,
  type ReadingsReportLike
} from '../perf-test/emit-perf-readings'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function report(overrides: Partial<ReadingsReportLike> = {}): ReadingsReportLike {
  return {
    timestamp: '2026-10-21T15:21:36.367Z',
    platform: 'win32-x64',
    perfEnv: 'ci',
    datasetImages: 1500,
    samples: [
      { id: 'cold-start-first-paint', value: 1839.7084, unit: 'ms' },
      { id: 'scan-ingest', value: 1900.3672, unit: 'ms' },
      { id: 'scan-throughput', value: 789.32, unit: 'items/sec' },
      { id: 'find-duplicates-throughput', value: 217.2, unit: 'items/sec' }
    ],
    ...overrides
  }
}

describe('buildPerfReadingsAnnotation 输出格式', () => {
  it('正常：单行 ::notice，title 固定为 perf-readings，带环境段/状态/样本数', () => {
    const line = buildPerfReadingsAnnotation(report(), { status: 'provisional', sampleCount: 2 })
    expect(line).toBe(
      '::notice title=perf-readings::env=ci status=provisional samples=2 dataset=1500 ' +
        'readings=cold-start-first-paint=1840;scan-ingest=1900;scan-throughput=789.3;find-duplicates-throughput=217.2'
    )
    expect(line.includes('\n')).toBe(false)
  })
  it('正常：读数按报告里的指标顺序输出，耗时取整、吞吐量保留一位小数', () => {
    const line = buildPerfReadingsAnnotation(report(), { status: 'final', sampleCount: 3 })
    const readings = line.split('readings=')[1].split(';')
    expect(readings.map((r) => r.split('=')[0])).toEqual([
      'cold-start-first-paint',
      'scan-ingest',
      'scan-throughput',
      'find-duplicates-throughput'
    ])
    expect(line).toContain('status=final samples=3')
  })
  it('异常：没有采样数据时拒绝输出（否则会打出一条恒空的假读数）', () => {
    expect(() =>
      buildPerfReadingsAnnotation(report({ samples: [] }), {
        status: 'provisional',
        sampleCount: 1
      })
    ).toThrowError(/采样/)
  })
  it('边界：报告缺 perfEnv 字段（本轮之前的旧存档）时标 unknown，不得冒充 dev', () => {
    const line = buildPerfReadingsAnnotation(
      { ...report(), perfEnv: undefined },
      { status: 'missing', sampleCount: 0 }
    )
    expect(line).toContain('env=unknown status=missing samples=0')
  })
  it('边界：百分号与换行必须按 workflow 命令规则转义，输出仍是单行', () => {
    const nasty = report({
      samples: [{ id: 'a%b\nc\rd', value: 1, unit: 'ms' }],
      platform: 'win\r\n32'
    })
    const line = buildPerfReadingsAnnotation(nasty, { status: 'final', sampleCount: 1 })
    expect(line.includes('\n')).toBe(false)
    expect(line.includes('\r')).toBe(false)
    expect(line).toContain('a%25b%Ac%Dd=1')
  })
})

describe('真实契约：CI 必须把读数打成注解', () => {
  const workflow = parse(
    readFileSync(path.join(ROOT_DIR, '.github', 'workflows', 'build.yml'), 'utf-8')
  ) as { jobs: Record<string, { steps: { name?: string; if?: string; run?: string }[] }> }
  const steps = workflow.jobs.build.steps

  it('build job 有一步跑 npm run perf:readings，且位于性能回归步骤之后', () => {
    const idx = steps.findIndex((s) => (s.run ?? '').includes('npm run perf:readings'))
    const perfIdx = steps.findIndex((s) =>
      (s.name ?? '').includes('Performance baseline regression')
    )
    expect(perfIdx, '缺少性能基准回归步骤').toBeGreaterThan(-1)
    expect(idx, 'build job 必须有一步调用 npm run perf:readings').toBeGreaterThan(-1)
    expect(idx, '读数注解必须在性能回归之后，否则读不到本次结果').toBeGreaterThan(perfIdx)
  })
  it('该步必须 if: always()：step 10 判红时也要能出数（否则补样要等一次绿运行）', () => {
    const step = steps.find((s) => (s.run ?? '').includes('npm run perf:readings'))
    expect(step?.if).toBe('always()')
  })
  it('package.json 必须注册 perf:readings 脚本', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['perf:readings']).toContain('scripts/perf-test/emit-perf-readings.ts')
  })
})
