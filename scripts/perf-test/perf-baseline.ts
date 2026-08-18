/**
 * T15：性能基线测试脚本
 *
 * 用途：测量应用在万级数据下的关键性能指标，建立基线供后续对比
 *
 * 测试场景：
 *   1. 首次扫描耗时（从触发扫描到 scanner:complete 事件）
 *   2. 媒体列表加载耗时（media:list IPC 响应时间）
 *   3. SQL 查询响应时间（按标签/套装/日期筛选）
 *   4. 缩略图生成耗时（首批 100 张）
 *
 * 用法：
 *   先启动应用（开发模式或生产构建），然后在应用内 DevTools Console 中粘贴本脚本执行
 *   或通过 Electron 的 remote debug 端口执行
 *
 * 前置条件：
 *   - 应用已启动并完成初始化
 *   - 数据库为空（首次测试）或已清空
 *   - 测试数据集已生成（运行 generate-dataset.ts）
 *
 * 输出：
 *   控制台打印各项指标，并生成 JSON 格式结果供复制到 baseline-2.2.md
 */

interface PerfResult {
  scenario: string
  metrics: {
    durationMs: number
    itemsProcessed?: number
    throughputPerSec?: number
  }
  detail?: string
  passed: boolean
  threshold?: { maxMs?: number; minThroughput?: number }
}

const results: PerfResult[] = []

async function measureScanDuration(scanPath: string): Promise<PerfResult> {
  const threshold = { maxMs: 5 * 60 * 1000 } // 5 分钟
  const startTime = Date.now()
  let filesFound = 0

  return new Promise((resolve) => {
    const off = window.electronAPI!.scanner.onComplete((result) => {
      const durationMs = Date.now() - startTime
      filesFound = result.filesFound || 0
      off()
      const passed = durationMs <= (threshold.maxMs || Infinity)
      const result: PerfResult = {
        scenario: '首次扫描耗时',
        metrics: {
          durationMs,
          itemsProcessed: filesFound,
          throughputPerSec: filesFound > 0 ? Math.round(filesFound / (durationMs / 1000)) : 0
        },
        detail: `扫描 ${filesFound} 个文件，吞吐量 ${filesFound > 0 ? Math.round(filesFound / (durationMs / 1000)) : 0} 文件/秒`,
        passed,
        threshold: { maxMs: threshold.maxMs }
      }
      results.push(result)
      resolve(result)
    })

    // 触发非增量扫描
    window.electronAPI!.scanner.start({ path: scanPath, incremental: false }).catch((err) => {
      const durationMs = Date.now() - startTime
      off()
      const failResult: PerfResult = {
        scenario: '首次扫描耗时',
        metrics: { durationMs, itemsProcessed: 0 },
        detail: `扫描失败: ${err}`,
        passed: false,
        threshold: { maxMs: threshold.maxMs }
      }
      results.push(failResult)
      resolve(failResult)
    })
  })
}

async function measureMediaListLoad(): Promise<PerfResult> {
  const threshold = { maxMs: 200 }
  const startTime = Date.now()
  try {
    const result = await window.electronAPI!.media.list({ page: 1, pageSize: 100 })
    const durationMs = Date.now() - startTime
    const total = result.total || 0
    const passed = durationMs <= threshold.maxMs
    const perfResult: PerfResult = {
      scenario: '媒体列表加载（首页 100 条）',
      metrics: { durationMs, itemsProcessed: total },
      detail: `加载 ${result.files?.length || 0} 条，总计 ${total} 条`,
      passed,
      threshold: { maxMs: threshold.maxMs }
    }
    results.push(perfResult)
    return perfResult
  } catch (err) {
    const durationMs = Date.now() - startTime
    const failResult: PerfResult = {
      scenario: '媒体列表加载',
      metrics: { durationMs },
      detail: `加载失败: ${err}`,
      passed: false,
      threshold
    }
    results.push(failResult)
    return failResult
  }
}

async function measureMediaListLargePage(): Promise<PerfResult> {
  const threshold = { maxMs: 500 }
  const startTime = Date.now()
  try {
    const result = await window.electronAPI!.media.list({ page: 1, pageSize: 500 })
    const durationMs = Date.now() - startTime
    const passed = durationMs <= threshold.maxMs
    const perfResult: PerfResult = {
      scenario: '媒体列表加载（大页 500 条）',
      metrics: { durationMs, itemsProcessed: result.files?.length || 0 },
      detail: `加载 ${result.files?.length || 0} 条`,
      passed,
      threshold: { maxMs: threshold.maxMs }
    }
    results.push(perfResult)
    return perfResult
  } catch (err) {
    const durationMs = Date.now() - startTime
    const failResult: PerfResult = {
      scenario: '媒体列表加载（大页）',
      metrics: { durationMs },
      detail: `加载失败: ${err}`,
      passed: false,
      threshold
    }
    results.push(failResult)
    return failResult
  }
}

async function measureDuplicateDetection(): Promise<PerfResult> {
  const threshold = { maxMs: 60 * 1000 } // 60 秒
  const startTime = Date.now()
  try {
    const result = await window.electronAPI!.media.findDuplicates()
    const durationMs = Date.now() - startTime
    const passed = durationMs <= threshold.maxMs
    const perfResult: PerfResult = {
      scenario: '重复文件检测（全量）',
      metrics: {
        durationMs,
        itemsProcessed: result.scannedFiles
      },
      detail: `扫描 ${result.scannedFiles} 个文件，发现 ${result.totalGroups} 组重复`,
      passed,
      threshold: { maxMs: threshold.maxMs }
    }
    results.push(perfResult)
    return perfResult
  } catch (err) {
    const durationMs = Date.now() - startTime
    const failResult: PerfResult = {
      scenario: '重复文件检测',
      metrics: { durationMs },
      detail: `检测失败: ${err}`,
      passed: false,
      threshold
    }
    results.push(failResult)
    return failResult
  }
}

async function measureCacheStats(): Promise<PerfResult> {
  const threshold = { maxMs: 200 }
  const startTime = Date.now()
  try {
    const result = await window.electronAPI!.cache.getStats()
    const durationMs = Date.now() - startTime
    const passed = durationMs <= threshold.maxMs
    const perfResult: PerfResult = {
      scenario: '缓存统计查询',
      metrics: { durationMs },
      detail: `缓存大小: ${result.totalSize} 字节，文件数: ${result.fileCount}`,
      passed,
      threshold: { maxMs: threshold.maxMs }
    }
    results.push(perfResult)
    return perfResult
  } catch (err) {
    const durationMs = Date.now() - startTime
    const failResult: PerfResult = {
      scenario: '缓存统计查询',
      metrics: { durationMs },
      detail: `查询失败: ${err}`,
      passed: false,
      threshold
    }
    results.push(failResult)
    return failResult
  }
}

function printReport(): void {
  console.log('\n========== T15 性能基线测试报告 ==========\n')
  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length
  console.log(`通过: ${passed} / ${results.length}，失败: ${failed}\n`)

  results.forEach((r, i) => {
    const status = r.passed ? '✓ PASS' : '✗ FAIL'
    console.log(`[${i + 1}] ${status}  ${r.scenario}`)
    console.log(
      `    耗时: ${r.metrics.durationMs}ms` +
        (r.threshold?.maxMs ? ` (阈值 ≤ ${r.threshold.maxMs}ms)` : '')
    )
    if (r.metrics.itemsProcessed !== undefined) {
      console.log(
        `    处理量: ${r.metrics.itemsProcessed} 项` +
          (r.metrics.throughputPerSec ? ` (${r.metrics.throughputPerSec}/秒)` : '')
      )
    }
    if (r.detail) console.log(`    详情: ${r.detail}`)
    console.log()
  })

  console.log('========== 测试结束 ==========\n')
  console.log('JSON 结果（复制到 baseline-2.2.md）:')
  console.log(JSON.stringify(results, null, 2))
}

// 主入口：在应用 DevTools Console 中调用 runPerfBaseline(scanPath)
async function runPerfBaseline(scanPath: string): Promise<void> {
  console.log(`[T15] 开始性能基线测试，扫描路径: ${scanPath}`)
  results.length = 0

  // 1. 扫描耗时
  console.log('\n[1/5] 测试首次扫描耗时...')
  await measureScanDuration(scanPath)

  // 等待扫描完成后的媒体列表刷新
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // 2. 媒体列表加载（首页）
  console.log('[2/5] 测试媒体列表加载（首页 100 条）...')
  await measureMediaListLoad()

  // 3. 媒体列表加载（大页）
  console.log('[3/5] 测试媒体列表加载（大页 500 条）...')
  await measureMediaListLargePage()

  // 4. 重复文件检测
  console.log('[4/5] 测试重复文件检测...')
  await measureDuplicateDetection()

  // 5. 缓存统计
  console.log('[5/5] 测试缓存统计查询...')
  await measureCacheStats()

  printReport()
}

// 暴露到 window 便于在 Console 调用
declare global {
  interface Window {
    runPerfBaseline: typeof runPerfBaseline
  }
}
window.runPerfBaseline = runPerfBaseline

console.log('[T15] 性能基线测试脚本已加载')
console.log('用法: 在 Console 中执行 runPerfBaseline("<扫描路径>")')
console.log('示例: await runPerfBaseline("C:\\\\perf-data")')
