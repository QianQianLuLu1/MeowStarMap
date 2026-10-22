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
 *   P2 数据集生成（准备步骤，不做门禁）
 *   P3 扫描入库（指定目录全量扫描 + 处理量/吞吐量）
 *   P4 媒体列表首页（100 条）  P5 媒体列表大页（500 条）
 *   P6 重复文件检测（全量）    P7 缓存统计查询
 *   P8 缩略图按需生成延迟（冷缓存 P50/P95 + thumbnail 为 NULL 行数 + 回写失败计数）
 *   P9 首图显影耗时（重新进入图库，首张 media:// 图片 onLoad）
 *   P10 基线对比与回归判定
 *
 * 判定：绝对阈值（硬护栏，全局共享） + 基线劣化（相对容忍区间，按运行环境分段 dev/ci），
 * 规则见 e2e/perf-baseline.json 与 e2e/perf-helpers.ts 的 DEFAULT_HARD_RULES；
 * 环境段由 resolvePerfEnv() 判定，结果落盘 .cache/perf/ 供追溯与基线更新。
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import path from 'node:path'
import { launchApp, closeApp, collectDiagLogs, type LaunchedApp } from './helpers'
import {
  DATASET_SIZE,
  countLogPattern,
  evaluateSamples,
  generatePerfDataset,
  loadBaseline,
  median,
  printPerfSummary,
  resolvePerfEnv,
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
    // 真实返回字段是 files（见 src/renderer/stores/mediaStore.ts 的 mediaResult.files 消费），
    // 不是 items——取样必须读 files，否则会把「查不到数据」误当成「性能达标」的假绿
    list: (options?: {
      page?: number
      pageSize?: number
      cursor?: { sortValue: string | number | null; id: number } | null
    }) => Promise<{ files?: unknown[]; total?: number; hasMore?: boolean }>
    findDuplicates: () => Promise<{
      success?: boolean
      scannedFiles?: number
      totalGroups?: number
    }>
  }
  cache: {
    getStats: () => Promise<{ totalSize?: number; fileCount?: number }>
  }
  thumbnail: {
    generate: (filePath: string, quality?: 'low' | 'standard' | 'high') => Promise<string | null>
  }
}

let launched: LaunchedApp | undefined
let win: Page
let datasetDir = ''
const samples: PerfSample[] = []
let reportSaved = false
/** 本次运行按哪个环境段判定（platform 串在开发机与 CI 上字面相同，无法用来区分环境） */
const perfEnv = resolvePerfEnv()

/** afterAll 兜底：未保存则落盘部分结果，采集诊断日志并关闭应用 */
// eslint-disable-next-line no-empty-pattern -- Playwright hook 首参必须是对象解构模式
test.afterAll(async ({}, testInfo: TestInfo) => {
  if (!reportSaved && samples.length > 0) {
    // 中途失败：保存已采集样本（无判定），便于排障
    const partial: PerfRunReport = {
      timestamp: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.version,
      perfEnv,
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

  test('P8 缩略图按需生成延迟（25 张 + thumbnail 为 NULL 行数）', async () => {
    test.slow() // 冷缓存下逐张解码原图，耗时与数据集规模/磁盘状态相关
    const SAMPLE_COUNT = 25
    const measured = await win.evaluate(async (sampleCount) => {
      const api = window.electronAPI as unknown as PerfAPI
      // 与图库首屏同一条查询路径（keyset 游标首页），取到的就是网格真正渲染的行
      const page = await api.media.list({ cursor: null, pageSize: 500 })
      const files = (page.files ?? []) as Array<{ file_path: string; thumbnail?: string | null }>
      const nullRows = files.filter((file) => !file.thumbnail)
      // 优先取 thumbnail 为 NULL 的行（真正走按需生成 + 回写）；不足则由已生成行补齐样本量，
      // 那些行测的是缓存命中路径（stat + 内容 hash 记忆化 + 引用回写）
      const picks = [...nullRows, ...files.filter((file) => file.thumbnail)]
        .slice(0, sampleCount)
        .map((file) => file.file_path)
      const durations: number[] = []
      let generatedPaths = 0
      for (const filePath of picks) {
        const t0 = performance.now()
        const generated = await api.thumbnail.generate(filePath)
        durations.push(performance.now() - t0)
        if (generated) generatedPaths++
      }
      return {
        pageRows: files.length,
        nullThumbnailRows: nullRows.length,
        coldSampled: Math.min(nullRows.length, sampleCount),
        sampled: picks.length,
        generatedPaths,
        durations
      }
    }, SAMPLE_COUNT)

    // 假绿防护：取不到行 = 契约漂移，必须炸，不能把「0 张采样」报成「0ms 达标」
    expect(measured.pageRows, 'media:list 首页必须返回记录（真实字段为 files）').toBeGreaterThan(0)
    expect(measured.sampled, `取样数应等于 ${SAMPLE_COUNT}`).toBe(SAMPLE_COUNT)
    expect(measured.generatedPaths, '按需生成应全部返回缩略图路径').toBe(measured.sampled)

    const sorted = [...measured.durations].sort((a, b) => a - b)
    const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
    const detail =
      `采样 ${measured.sampled} 张（其中缺缩略图 ${measured.coldSampled} 张）| ` +
      `首页 ${measured.pageRows} 行中 thumbnail 为 NULL: ${measured.nullThumbnailRows} 行`

    samples.push({
      id: 'thumbnail-generate-p50',
      scenario: '缩略图按需生成 P50',
      value: median(sorted),
      unit: 'ms',
      itemsProcessed: measured.sampled,
      rawSamples: sorted.map((d) => Math.round(d)),
      detail
    })
    samples.push({
      id: 'thumbnail-generate-p95',
      scenario: '缩略图按需生成 P95',
      value: sorted[p95Index],
      unit: 'ms',
      itemsProcessed: measured.sampled,
      detail
    })
    process.stdout.write(`[perf] ${detail}\n`)
  })

  test('P9 首图显影耗时（重新进入图库）+ 生成链路副作用计数', async () => {
    // 覆盖用户可感知的「切板块/重开应用要重新等一遍」：从 renderer 重新挂载开始计时，
    // 到网格出现第一张真正解码成功的 media:// 图片为止（naturalWidth>0 排除裂图）
    const start = performance.now()
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForFunction(
      () => {
        const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[]
        return imgs.some(
          (img) => img.src.startsWith('media://') && img.complete && img.naturalWidth > 0
        )
      },
      undefined,
      { timeout: 60_000 }
    )
    const firstVisibleMs = performance.now() - start
    // 给按需生成一段沉降时间：首图之后网格仍在批量补齐，回写失败也发生在这段时间里
    await win.waitForTimeout(3_000)
    const afterSettle = await win.evaluate(async () => {
      const api = window.electronAPI as unknown as PerfAPI
      const page = await api.media.list({ cursor: null, pageSize: 500 })
      const files = (page.files ?? []) as Array<{ thumbnail?: string | null }>
      return {
        pageRows: files.length,
        nullThumbnailRows: files.filter((file) => !file.thumbnail).length,
        skeletonCount: document.querySelectorAll('.skeleton').length
      }
    })

    samples.push({
      id: 'first-thumbnail-visible',
      scenario: '首图显影耗时（重新进入图库）',
      value: firstVisibleMs,
      unit: 'ms',
      detail:
        `沉降 3s 后骨架卡数: ${afterSettle.skeletonCount} | ` +
        `首页 ${afterSettle.pageRows} 行中 thumbnail 仍为 NULL: ${afterSettle.nullThumbnailRows} 行`
    })

    // 「回写数据库失败」是每会话重复生成死循环的入口，耗时指标看不出来，只能从日志数
    const writeBackFailures = await countLogPattern(
      launched!.userDataDir,
      /按需生成结果回写数据库失败/
    )
    const workerDegraded = await countLogPattern(
      launched!.userDataDir,
      /workerCallFailed|handshakeFailed|worker 超时|异常退出/
    )
    process.stdout.write(
      `[perf] 缩略图回写数据库失败次数: ${writeBackFailures.count}；worker 降级/超时相关告警: ${workerDegraded.count}\n`
    )
    for (const line of writeBackFailures.samples) process.stdout.write(`  ↳ ${line}\n`)
    for (const line of workerDegraded.samples) process.stdout.write(`  ↳ ${line}\n`)
  })

  test('P10 基线对比与回归判定', async () => {
    const baseline = await loadBaseline()
    const violations = evaluateSamples(samples, baseline, perfEnv)
    const report: PerfRunReport = {
      timestamp: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.version,
      perfEnv,
      datasetImages: DATASET_SIZE,
      samples,
      violations,
      passed: violations.length === 0
    }
    const archivePath = await savePerfReport(report)
    reportSaved = true
    printPerfSummary(report, baseline)
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
