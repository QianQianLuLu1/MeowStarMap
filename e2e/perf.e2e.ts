/**
 * 性能基准回归套件（@perf，见 docs/perf-regression.md）
 *
 * 前置要求：release/win-unpacked 已存在（本地先执行 npm run dist:win；CI 由 build 步骤产出）。
 * 运行方式：
 *   - 仅性能：npm run e2e:perf
 *   - 冒烟默认排除 @perf（package.json e2e:smoke 使用 --grep-invert @perf）
 *
 * 场景覆盖（与 T15 手工脚本 scripts/perf-test/perf-baseline.ts 对齐并自动化）：
 *   P1 冷启动（启动 + 首启建库 + 首屏渲染）
 *   P2 扫描入库（指定目录全量扫描 + 处理量/吞吐量）
 *   P3 媒体列表首页（100 条）  P4 媒体列表大页（500 条）
 *   P5 重复文件检测（全量）    P6 缓存统计查询
 *
 * 判定：绝对阈值（硬护栏） + 基线劣化（相对容忍区间），规则见 e2e/perf-baseline.json
 * 与 e2e/perf-helpers.ts 的 DEFAULT_HARD_RULES；结果落盘 .cache/perf/ 供追溯与基线更新。
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import path from 'node:path'
import { launchApp, closeApp, collectDiagLogs, type LaunchedApp } from './helpers'
import {
  DATASET_SIZE,
  evaluateSamples,
  generatePerfDataset,
  loadBaseline,
  median,
  printPerfSummary,
  savePerfReport,
  type PerfRunReport,
  type PerfSample
} from './perf-helpers'

/**
 * 性能套件所需的 electronAPI 断面（局部类型，通过断言使用，
 * 避免与 smoke.e2e.ts 的 declare global Window 声明合并冲突）
 */
interface PerfAPI {
  scanner: {
    start: (options?: { path?: string; incremental?: boolean }) => Promise<{
      success?: boolean
      message?: string
      filesFound?: number
    }>
  }
  media: {
    list: (options?: { page?: number; pageSize?: number }) => Promise<{
      items?: unknown[]
      total?: number
    }>
    findDuplicates: () => Promise<{
      success?: boolean
      scannedFiles?: number
      totalGroups?: number
    }>
  }
  cache: {
    getStats: () => Promise<{ totalSize?: number; fileCount?: number }>
  }
}

let launched: LaunchedApp | undefined
let win: Page
let datasetDir = ''
const samples: PerfSample[] = []
let reportSaved = false

/** afterAll 兜底：未保存则落盘部分结果，采集诊断日志并关闭应用 */
// eslint-disable-next-line no-empty-pattern -- Playwright hook 首参必须是对象解构模式
test.afterAll(async ({}, testInfo: TestInfo) => {
  if (!reportSaved && samples.length > 0) {
    // 中途失败：保存已采集样本（无判定），便于排障
    const partial: PerfRunReport = {
      timestamp: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.version,
      datasetImages: DATASET_SIZE,
      samples,
      violations: [],
      passed: false
    }
    await savePerfReport(partial)
  }
  if (launched) {
    await collectDiagLogs(launched.userDataDir, testInfo.outputDir)
  }
  await closeApp(launched)
  launched = undefined
})

test.describe.serial('性能基准回归（@perf，win-unpacked）', () => {
  test('P1 冷启动：应用启动 + 首启建库 + 首屏渲染', async () => {
    // 全新临时 userData → 覆盖首启建库/迁移路径；计时含 Electron 进程拉起，
    // 对应「启动或数据库初始化 + 首页加载」两个关键场景
    const start = performance.now()
    launched = await launchApp()
    win = await launched.app.firstWindow()
    await win.waitForLoadState('domcontentloaded', { timeout: 20_000 })
    // 首屏渲染判据与冒烟 S2 一致：#root 挂载且含真实内容
    await win.waitForFunction(
      () => {
        const root = document.getElementById('root')
        return !!root && root.childElementCount > 0 && root.querySelectorAll('*').length > 10
      },
      undefined,
      { timeout: 20_000 }
    )
    samples.push({
      id: 'cold-start-first-paint',
      scenario: '冷启动（启动+建库+首屏）',
      value: performance.now() - start,
      unit: 'ms'
    })
  })

  test('P2 数据集生成（测试准备，留档不做门禁）', async () => {
    // 落在临时 userData 内：pathGuard 对 userData 目录始终放行，扫描无需额外授权
    datasetDir = path.join(launched!.userDataDir, 'perf-dataset')
    const { generated, elapsedMs } = await generatePerfDataset(datasetDir, DATASET_SIZE)
    expect(generated).toBe(DATASET_SIZE)
    process.stdout.write(`[perf] 数据集生成完成: ${generated} 个文件, ${elapsedMs}ms\n`)
  })

  test('P3 扫描入库（全量扫描 + 吞吐量）', async () => {
    test.slow() // 扫描耗时与数据集规模成正比，放宽至 3 倍超时
    const start = performance.now()
    const result = await win.evaluate(async (dir) => {
      const api = window.electronAPI as unknown as PerfAPI
      return await api.scanner.start({ path: dir, incremental: false })
    }, datasetDir)
    const elapsedMs = performance.now() - start

    expect(result.success, `扫描应成功，实际返回: ${JSON.stringify(result)}`).toBeTruthy()
    // 处理量门禁：全部占位文件都应入库，漏扫即判定失败
    expect(result.filesFound, '扫描发现的图片数应与数据集一致').toBe(DATASET_SIZE)

    const throughput = DATASET_SIZE / (elapsedMs / 1000)
    samples.push({
      id: 'scan-ingest',
      scenario: `扫描入库（${DATASET_SIZE} 张）`,
      value: elapsedMs,
      unit: 'ms',
      itemsProcessed: DATASET_SIZE,
      detail: `吞吐量 ${throughput.toFixed(1)} 文件/秒`
    })
    samples.push({
      id: 'scan-throughput',
      scenario: '扫描吞吐量',
      value: Number(throughput.toFixed(2)),
      unit: 'items/sec',
      itemsProcessed: DATASET_SIZE
    })
  })

  test('P4 媒体列表加载（首页 100 条）', async () => {
    // 1 次预热（扫描后首次查询可能触发 media_count 缓存重建），再取 5 次中位数
    await win.evaluate(async () => {
      const api = window.electronAPI as unknown as PerfAPI
      await api.media.list({ page: 1, pageSize: 100 })
    })
    const durations = await win.evaluate(async () => {
      const api = window.electronAPI as unknown as PerfAPI
      const rounds: number[] = []
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        await api.media.list({ page: 1, pageSize: 100 })
        rounds.push(performance.now() - t0)
      }
      return rounds
    })
    const value = median(durations)
    samples.push({
      id: 'media-list-page100',
      scenario: '媒体列表加载（首页 100 条）',
      value,
      unit: 'ms',
      itemsProcessed: 100,
      rawSamples: durations.map((d) => Math.round(d))
    })
  })

  test('P5 媒体列表加载（大页 500 条）', async () => {
    await win.evaluate(async () => {
      const api = window.electronAPI as unknown as PerfAPI
      await api.media.list({ page: 1, pageSize: 500 })
    })
    const durations = await win.evaluate(async () => {
      const api = window.electronAPI as unknown as PerfAPI
      const rounds: number[] = []
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        await api.media.list({ page: 1, pageSize: 500 })
        rounds.push(performance.now() - t0)
      }
      return rounds
    })
    const value = median(durations)
    samples.push({
      id: 'media-list-page500',
      scenario: '媒体列表加载（大页 500 条）',
      value,
      unit: 'ms',
      itemsProcessed: 500,
      rawSamples: durations.map((d) => Math.round(d))
    })
  })

  test('P6 重复文件检测（全量哈希分组）', async () => {
    test.slow()
    const start = performance.now()
    const result = await win.evaluate(async () => {
      const api = window.electronAPI as unknown as PerfAPI
      return await api.media.findDuplicates()
    })
    const elapsedMs = performance.now() - start

    expect(result.success, `重复检测应成功，实际返回: ${JSON.stringify(result)}`).toBeTruthy()
    const scanned = result.scannedFiles ?? 0
    expect(scanned, '应覆盖全部已入库文件').toBeGreaterThan(0)

    const throughput = scanned / (elapsedMs / 1000)
    samples.push({
      id: 'find-duplicates',
      scenario: `重复文件检测（${scanned} 个文件）`,
      value: elapsedMs,
      unit: 'ms',
      itemsProcessed: scanned,
      detail: `发现 ${result.totalGroups ?? 0} 组重复`
    })
    samples.push({
      id: 'find-duplicates-throughput',
      scenario: '重复检测吞吐量',
      value: Number(throughput.toFixed(2)),
      unit: 'items/sec',
      itemsProcessed: scanned
    })
  })

  test('P7 缓存统计查询', async () => {
    // 1 次预热 + 5 次中位数（缓存目录遍历耗时受缩略图后台生成影响，取中位数降噪）
    await win.evaluate(async () => {
      const api = window.electronAPI as unknown as PerfAPI
      await api.cache.getStats()
    })
    const durations = await win.evaluate(async () => {
      const api = window.electronAPI as unknown as PerfAPI
      const rounds: number[] = []
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        await api.cache.getStats()
        rounds.push(performance.now() - t0)
      }
      return rounds
    })
    samples.push({
      id: 'cache-get-stats',
      scenario: '缓存统计查询',
      value: median(durations),
      unit: 'ms',
      rawSamples: durations.map((d) => Math.round(d))
    })
  })

  test('P8 基线对比与回归判定', async () => {
    const baseline = await loadBaseline()
    const violations = evaluateSamples(samples, baseline)
    const report: PerfRunReport = {
      timestamp: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.version,
      datasetImages: DATASET_SIZE,
      samples,
      violations,
      passed: violations.length === 0
    }
    const archivePath = await savePerfReport(report)
    reportSaved = true
    printPerfSummary(report)
    process.stdout.write(`[perf] 结果已保存: ${archivePath}\n`)
    if (!baseline) {
      process.stdout.write(
        '[perf] 未找到基线文件，本次仅执行绝对阈值判定；可用 npm run perf:save-baseline 固化基线\n'
      )
    }
    expect(
      violations.map((v) => v.message),
      '存在性能回归 / 阈值超限，详见上方报告'
    ).toHaveLength(0)
  })
})
